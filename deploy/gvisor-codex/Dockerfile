FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git tmux \
    && curl -fsSL https://chatgpt.com/codex/install.sh \
      | CODEX_NON_INTERACTIVE=1 CODEX_INSTALL_DIR=/usr/local/bin sh \
    && codex --version \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

CMD ["tail", "-f", "/dev/null"]
