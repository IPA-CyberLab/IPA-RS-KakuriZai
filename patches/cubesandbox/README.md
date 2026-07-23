# CubeSandbox patches

These patches are applied on top of the exact Tencent CubeSandbox revision
recorded by the `vendor/CubeSandbox` submodule.

```bash
./scripts/apply-cubesandbox-patches.sh
make -C vendor/CubeSandbox cubelet
```

The apply script is idempotent and fails if an upstream update no longer
matches a patch cleanly.
