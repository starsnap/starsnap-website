#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

readonly runner_uid="1001"
readonly runner_home="/home/runner"
readonly state_dir="/runner-state"
readonly token_file="/run/secrets/github_runner_registration_token"
readonly registration_sentinel="$state_dir/.registration-in-progress"
readonly org_url="https://github.com/starsnap"
readonly runner_name="starsnap-swarm-arm64-01"
readonly runner_group="starsnap-production"
readonly runner_labels="starsnap-swarm"
readonly -a required_state_files=(.runner .credentials .credentials_rsaparams)
readonly -a optional_state_files=(.env .path)

if [[ "${1:-}" != "--as-runner" ]]; then
  if [[ "$(id -u)" != "0" ]]; then
    echo "Bootstrap must start as root." >&2
    exit 1
  fi

  if [[ ! -S /var/run/docker.sock ]]; then
    echo "Docker socket is missing." >&2
    exit 1
  fi

  socket_gid="$(stat -c '%g' /var/run/docker.sock)"
  if [[ ! "$socket_gid" =~ ^[0-9]+$ ]]; then
    echo "Invalid Docker socket GID." >&2
    exit 1
  fi

  install -d -o "$runner_uid" -g "$runner_uid" -m 0700 "$state_dir"

  exec setpriv \
    --reuid="$runner_uid" \
    --regid="$socket_gid" \
    --clear-groups \
    --bounding-set=-all \
    --inh-caps=-all \
    --ambient-caps=-all \
    --no-new-privs \
    "$0" --as-runner
fi

if [[ "$(id -u)" != "$runner_uid" ]]; then
  echo "Runner privilege drop failed." >&2
  exit 1
fi

if ! docker info --format '{{.Swarm.ControlAvailable}}' | grep -Fxq true; then
  echo "Runner must be attached to a Swarm manager socket." >&2
  exit 1
fi

cd "$runner_home"

state_count=0
for state_file in "${required_state_files[@]}"; do
  if [[ -s "$state_dir/$state_file" ]]; then
    ((state_count += 1))
  fi
done

if [[ -e "$registration_sentinel" ]] && ((state_count != ${#required_state_files[@]})); then
  echo "A previous registration did not finish; manual runner cleanup is required." >&2
  exit 1
fi

if ((state_count != 0 && state_count != ${#required_state_files[@]})); then
  echo "Runner state is incomplete; refusing automatic re-registration." >&2
  exit 1
fi

if ((state_count == ${#required_state_files[@]})); then
  rm -f -- "$registration_sentinel"

  for state_file in "${required_state_files[@]}" "${optional_state_files[@]}"; do
    if [[ -f "$state_dir/$state_file" ]]; then
      install -m 0600 "$state_dir/$state_file" "$runner_home/$state_file"
    fi
  done
else
  if [[ ! -s "$token_file" ]]; then
    echo "Registration token secret is required for first bootstrap." >&2
    exit 1
  fi

  install -m 0600 /dev/null "$registration_sentinel"

  registration_token="$(<"$token_file")"
  ./config.sh \
    --unattended \
    --url "$org_url" \
    --token "$registration_token" \
    --name "$runner_name" \
    --runnergroup "$runner_group" \
    --labels "$runner_labels" \
    --no-default-labels \
    --work _work \
    --disableupdate
  unset registration_token

  for state_file in "${required_state_files[@]}"; do
    if [[ ! -s "$runner_home/$state_file" ]]; then
      echo "Runner registration did not create complete credentials." >&2
      exit 1
    fi
  done

  state_tmp_dir="$state_dir/.state-tmp-$$"
  cleanup_state_tmp() {
    if [[ -n "${state_tmp_dir:-}" && -d "$state_tmp_dir" ]]; then
      rm -rf -- "$state_tmp_dir"
    fi
  }
  trap cleanup_state_tmp EXIT

  install -d -m 0700 "$state_tmp_dir"
  for state_file in "${required_state_files[@]}" "${optional_state_files[@]}"; do
    if [[ -f "$runner_home/$state_file" ]]; then
      install -m 0600 "$runner_home/$state_file" "$state_tmp_dir/$state_file"
    fi
  done

  for state_file in "${required_state_files[@]}"; do
    if [[ ! -s "$state_tmp_dir/$state_file" ]]; then
      echo "Runner state staging is incomplete." >&2
      exit 1
    fi
  done

  for state_file in "${required_state_files[@]}" "${optional_state_files[@]}"; do
    if [[ -f "$state_tmp_dir/$state_file" ]]; then
      mv -- "$state_tmp_dir/$state_file" "$state_dir/$state_file"
    fi
  done

  rmdir -- "$state_tmp_dir"
  state_tmp_dir=""
  rm -f -- "$registration_sentinel"
  trap - EXIT
fi

exec ./run.sh
