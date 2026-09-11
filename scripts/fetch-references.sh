#!/usr/bin/env bash
# Clone reference implementations into .refs/ (git-ignored). Pinned x402 commit matches docs/reference.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .refs
X402_COMMIT=$(cut -d' ' -f1 docs/reference/UPSTREAM_COMMIT.txt)
if [ ! -d .refs/x402 ]; then
  git clone https://github.com/x402-foundation/x402.git .refs/x402
fi
git -C .refs/x402 fetch --quiet origin && git -C .refs/x402 checkout --quiet "$X402_COMMIT" || \
  echo "WARN: pinned commit unavailable, staying on default branch"
[ -d .refs/x402-demo ] || git clone --depth 1 https://github.com/algorandfoundation/x402-demo.git .refs/x402-demo
echo "References ready in .refs/"
echo "Upstream HEAD: $(git -C .refs/x402 log -1 --format='%h %cd')"
