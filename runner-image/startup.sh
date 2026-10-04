#!/usr/bin/env bash
# GCE startup script for pm-hub runner VMs (runners.mode = "gce").
#
# The workflow's `launch` job creates the VM with two metadata keys:
#   jitconfig             — the encoded JIT runner config minted via
#                           POST /repos/{hub}/actions/runners/generate-jitconfig
#   self-destruct-minutes — job timeout + 15: the VM deletes itself at that
#                           point even if `teardown` never ran
# The runner runs ONE job (JIT runners are ephemeral) and the VM deletes itself after it,
# so a VM never outlives its run. The hub.json image (runner-image/packer.pkr.hcl)
# provides /opt/runner and the toolchain.
set -euo pipefail

META="http://metadata.google.internal/computeMetadata/v1"
meta() { curl -fsS -H "Metadata-Flavor: Google" "$META/$1"; }

JITCONFIG=$(meta instance/attributes/jitconfig)
MINUTES=$(meta instance/attributes/self-destruct-minutes || echo 315)
NAME=$(meta instance/name)
ZONE=$(meta instance/zone | awk -F/ '{print $NF}')
PROJECT=$(meta project/project-id)

self_delete() {
  # Needs the compute-rw scope the launch job grants; falls back to a halt
  # (teardown deletes a stopped VM too).
  token=$(meta 'instance/service-accounts/default/token' | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')
  curl -fsS -X DELETE -H "Authorization: Bearer $token" \
    "https://compute.googleapis.com/compute/v1/projects/$PROJECT/zones/$ZONE/instances/$NAME" \
    || shutdown -h now
}

# Backstop: self-destruct at the deadline no matter what the runner does.
( sleep $((MINUTES * 60)); echo "pm-runner: deadline reached, deleting $NAME"; self_delete ) &

cd /opt/runner
export RUNNER_ALLOW_RUNASROOT=0
export HOME=/home/runner
# A JIT-configured runner is ephemeral by definition: it takes ONE job and
# de-registers. The JIT config already carries the label (pm-<run id>) the
# `run` job targets.
sudo -u runner -E ./run.sh --jitconfig "$JITCONFIG" || true

echo "pm-runner: job finished, deleting $NAME"
self_delete
