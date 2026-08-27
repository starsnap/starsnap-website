import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const verifierPath = fileURLToPath(new URL("./verify-ollama.mjs", import.meta.url));
const modelName = "bge-m3:567m-fp16";
const expectedDigest = "7907646426070047a77226ac3e684fbbe8410524f7b4a74d02837e43f2146bab";
let digest = expectedDigest;
let embeddingModel = modelName;
let vector = [1, ...Array(1023).fill(0)];

const server = createServer((request, response) => {
  response.setHeader("content-type", "application/json");
  if (request.method === "GET" && request.url === "/api/tags") {
    response.end(JSON.stringify({ models: [{ name: modelName, digest }] }));
    return;
  }
  if (request.method === "POST" && request.url === "/api/embed") {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        assert.equal(body.model, modelName);
        assert.deepEqual(body.input, ["StarSnap Ollama health probe"]);
        response.end(JSON.stringify({ model: embeddingModel, embeddings: [vector] }));
      } catch {
        response.statusCode = 400;
        response.end(JSON.stringify({ error: "invalid request" }));
      }
    });
    return;
  }

  response.statusCode = 404;
  response.end(JSON.stringify({ error: "not found" }));
});

function runVerifier(baseUrl) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [verifierPath], {
      env: { ...process.env, ERP_EMBEDDING_BASE_URL: baseUrl },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({
      code,
      stdout: Buffer.concat(stdout).toString("utf8").trim(),
      stderr: Buffer.concat(stderr).toString("utf8").trim(),
    }));
  });
}

async function expectFailure(baseUrl, expectedMessage) {
  const result = await runVerifier(baseUrl);
  assert.equal(result.code, 1);
  assert.match(result.stderr, expectedMessage);
  assert.equal(result.stdout, "");
}

try {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const success = await runVerifier(baseUrl);
  assert.equal(success.code, 0, success.stderr);
  assert.equal(
    success.stdout,
    "Ollama semantic probe passed: digest=790764642607 dimension=1024",
  );
  assert.equal(success.stderr, "");

  digest = `${expectedDigest.slice(0, -1)}a`;
  await expectFailure(
    baseUrl,
    /Pinned Ollama model is missing or has an unexpected digest/,
  );

  digest = expectedDigest;
  embeddingModel = "unexpected-model";
  await expectFailure(
    baseUrl,
    /Ollama embedding probe returned an unexpected model/,
  );

  embeddingModel = modelName;
  vector = Array(1024).fill(0);
  await expectFailure(
    baseUrl,
    /Ollama embedding probe returned a non-unit vector/,
  );

  console.log("Ollama semantic verifier tests passed.");
} finally {
  server.close();
  await once(server, "close");
}
