#!/usr/bin/env bash
# Step 3: audit another GPU's outputs on this GPU.
# First copy the other machine's out/<other>/llm.json and out/<other>/traces/lat*.npy to src/<other>/ here.
# Usage: bash run_cross_audit.sh <this-tag> <other-tag> [<other-tag> ...]
set -uo pipefail
ME=${1:?usage: run_cross_audit.sh <this-tag> <other-tag>...}; shift
export HF_HUB_ENABLE_HF_TRANSFER=1
for other in "$@"; do
  python bench.py audit_llm  --out "out/$ME" --src "src/$other" > "audit_llm_$other.log" 2>&1;  echo "audit_llm $other exit $?"
  python bench.py audit_diff --out "out/$ME" --src "src/$other" > "audit_diff_$other.log" 2>&1; echo "audit_diff $other exit $?"
done
