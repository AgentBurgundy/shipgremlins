# The GCE runner image for runners.mode = "gce": Ubuntu 24.04 plus the same
# toolchain a self-hosted runner needs (docs/runners.md) and the GitHub
# Actions runner unpacked under /opt/runner. Built by
# .github/workflows/make-runner-image.yml; VMs created from it by the
# workflows' `launch` jobs boot with runner-image/startup.sh as their startup
# script, which registers the runner from the `jitconfig` metadata and runs
# ONE job (--ephemeral).

packer {
  required_plugins {
    googlecompute = {
      source  = "github.com/hashicorp/googlecompute"
      version = ">= 1.1.0"
    }
  }
}

variable "project" {
  type = string
}

variable "zone" {
  type    = string
  default = "us-central1-a"
}

variable "image_name" {
  type    = string
  default = "pm-runner"
}

variable "runner_version" {
  type    = string
  default = "2.321.0"
}

variable "node_major" {
  type    = string
  default = "22"
}

source "googlecompute" "runner" {
  project_id          = var.project
  zone                = var.zone
  source_image_family = "ubuntu-2404-lts-amd64"
  machine_type        = "e2-standard-4"
  disk_size           = 50
  ssh_username        = "packer"
  image_name          = "${var.image_name}-{{timestamp}}"
  image_family        = var.image_name
  image_description   = "pm-hub runner: Node ${var.node_major}, git, gh, Chromium deps, Claude Code, actions/runner ${var.runner_version}"
}

build {
  sources = ["source.googlecompute.runner"]

  provisioner "shell" {
    environment_vars = [
      "DEBIAN_FRONTEND=noninteractive",
      "RUNNER_VERSION=${var.runner_version}",
      "NODE_MAJOR=${var.node_major}",
    ]
    inline = [
      "set -euo pipefail",
      "sudo apt-get update",
      "sudo apt-get install -y --no-install-recommends ca-certificates curl git jq unzip build-essential python3",
      # Node 22 from NodeSource.
      "curl -fsSL https://deb.nodesource.com/setup_$${NODE_MAJOR}.x | sudo -E bash -",
      "sudo apt-get install -y nodejs",
      # GitHub CLI (the prompts open PRs and comment with it).
      "curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg",
      "echo 'deb [arch=amd64 signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main' | sudo tee /etc/apt/sources.list.d/github-cli.list",
      "sudo apt-get update && sudo apt-get install -y gh",
      # Playwright Chromium + its OS libraries, for the PM's browser.
      "sudo npx -y playwright@1.49.0 install-deps chromium",
      # Claude Code CLI; the OAuth token arrives per run as an env var.
      "sudo npm i -g @anthropic-ai/claude-code",
      # The Actions runner, unconfigured: startup.sh configures it per boot.
      "sudo useradd -m -s /bin/bash runner || true",
      "sudo mkdir -p /opt/runner",
      "curl -fsSL -o /tmp/runner.tgz https://github.com/actions/runner/releases/download/v$${RUNNER_VERSION}/actions-runner-linux-x64-$${RUNNER_VERSION}.tar.gz",
      "sudo tar -xzf /tmp/runner.tgz -C /opt/runner",
      "sudo /opt/runner/bin/installdependencies.sh",
      "sudo chown -R runner:runner /opt/runner",
      "echo 'runner ALL=(ALL) NOPASSWD:ALL' | sudo tee /etc/sudoers.d/runner",
      "sudo apt-get clean",
    ]
  }
}
