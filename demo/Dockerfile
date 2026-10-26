# The demo box: code-server (VS Code in the browser) with Ophan installed from this checkout.
# Built by demo/box.sh after demo/prepare.sh has packaged the extension and CLI into demo/out/build.
FROM codercom/code-server:4.141.1

USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 \
  && rm -rf /var/lib/apt/lists/*

# Node.js on PATH: the extension runs the CLI with `npx @ophan/cli`, as it does on a laptop.
COPY --from=node:24-trixie-slim /usr/local/bin/node /usr/local/bin/node
COPY --from=node:24-trixie-slim /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
  && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

COPY out/build/ophan.vsix out/build/ophan-cli.tgz /opt/ophan/
COPY sample-app /opt/acme-api
RUN chown -R coder:coder /opt/acme-api

USER coder
# The sample app gets the CLI as a dev dependency (the documented `npm install -D @ophan/cli`),
# so `npx @ophan/cli` resolves to this checkout's build rather than the npm registry.
RUN cd /opt/acme-api && npm install --save-dev --no-audit --no-fund /opt/ophan/ophan-cli.tgz \
  && code-server --install-extension /opt/ophan/ophan.vsix
COPY --chown=coder:coder box/settings.json /home/coder/.local/share/code-server/User/settings.json
