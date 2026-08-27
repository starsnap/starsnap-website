const modelName = "bge-m3:567m-fp16";
const expectedDigest = "7907646426070047a77226ac3e684fbbe8410524f7b4a74d02837e43f2146bab";
const expectedDimension = 1024;
const unitNormTolerance = 1e-3;

function endpoint(path) {
  const configured = process.env.ERP_EMBEDDING_BASE_URL?.trim();
  if (!configured) {
    throw new Error("ERP_EMBEDDING_BASE_URL is missing from the ERP web task");
  }

  let parsed;
  try {
    parsed = new URL(configured);
  } catch {
    throw new Error("ERP_EMBEDDING_BASE_URL is not a valid URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("ERP_EMBEDDING_BASE_URL must be an HTTP(S) URL without credentials");
  }

  return `${parsed.toString().replace(/\/$/, "")}${path}`;
}

async function fetchJson(path, init, timeoutMs, label) {
  let response;
  try {
    response = await fetch(endpoint(path), {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const reason = error instanceof Error && error.name === "TimeoutError" ? "timed out" : "failed";
    throw new Error(`${label} ${reason}`);
  }
  if (!response.ok) {
    throw new Error(`${label} returned HTTP ${response.status}`);
  }

  try {
    return await response.json();
  } catch {
    throw new Error(`${label} did not return JSON`);
  }
}

async function main() {
  const tags = await fetchJson(
    "/api/tags",
    { headers: { accept: "application/json" } },
    10_000,
    "Ollama tags probe",
  );
  const models = Array.isArray(tags?.models) ? tags.models : [];
  const model = models.find((candidate) =>
    candidate?.name === modelName || candidate?.model === modelName,
  );
  const digest = typeof model?.digest === "string" ? model.digest.toLowerCase() : "";
  if (digest !== expectedDigest) {
    throw new Error("Pinned Ollama model is missing or has an unexpected digest");
  }

  const embedding = await fetchJson(
    "/api/embed",
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: modelName,
        input: ["StarSnap Ollama health probe"],
      }),
    },
    120_000,
    "Ollama embedding probe",
  );
  if (embedding?.model !== modelName) {
    throw new Error("Ollama embedding probe returned an unexpected model");
  }
  const vector = embedding?.embeddings?.[0];
  if (
    !Array.isArray(vector)
    || vector.length !== expectedDimension
    || !vector.every(Number.isFinite)
  ) {
    throw new Error("Ollama embedding probe returned an invalid vector");
  }
  const l2Norm = Math.sqrt(vector.reduce((sum, value) => sum + (value * value), 0));
  if (!Number.isFinite(l2Norm) || Math.abs(l2Norm - 1) > unitNormTolerance) {
    throw new Error("Ollama embedding probe returned a non-unit vector");
  }

  console.log(
    `Ollama semantic probe passed: digest=${digest.slice(0, 12)} dimension=${vector.length}`,
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "unknown failure";
  console.error(`Ollama semantic probe failed: ${message}`);
  process.exitCode = 1;
});
