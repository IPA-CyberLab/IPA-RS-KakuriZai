# Developer sandbox

This is a KakuriZai Terraform template. KakuriZai injects the local
`.kakurizai/modules/sandbox` runtime module when it creates an instance, so the
checked-in template stays small and contains only the user-facing definition.

Publish it with:

```sh
agctl templates push developer-sandbox \
  --display-name "Developer sandbox" \
  --description "CubeSandbox developer environment" \
  --directory ./templates/developer-sandbox
```

Every root `variable` is shown in Studio when a user creates a sandbox. The
`name` string variable is required and is supplied by KakuriZai.
