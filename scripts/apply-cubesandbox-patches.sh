#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cube_dir="${repo_root}/vendor/CubeSandbox"
patch_dir="${repo_root}/patches/cubesandbox"

if [[ ! -d "${cube_dir}/.git" && ! -f "${cube_dir}/.git" ]]; then
  printf 'CubeSandbox submodule is not initialized: %s\n' "${cube_dir}" >&2
  exit 1
fi

shopt -s nullglob
patches=("${patch_dir}"/*.patch)
if ((${#patches[@]} == 0)); then
  printf 'No CubeSandbox patches found in %s\n' "${patch_dir}" >&2
  exit 1
fi

for patch_file in "${patches[@]}"; do
  if git -C "${cube_dir}" apply --check "${patch_file}" 2>/dev/null; then
    git -C "${cube_dir}" apply "${patch_file}"
    printf 'Applied %s\n' "$(basename "${patch_file}")"
  elif git -C "${cube_dir}" apply --reverse --check "${patch_file}" 2>/dev/null; then
    printf 'Already applied %s\n' "$(basename "${patch_file}")"
  else
    printf 'Patch does not apply cleanly: %s\n' "${patch_file}" >&2
    exit 1
  fi
done
