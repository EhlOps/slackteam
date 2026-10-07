FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      git openssh-client ca-certificates curl python3 make g++ \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/githubcli.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y gh && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && mkdir -p /data && chown -R node:node /data /app
USER node
ENV GIT_AUTHOR_NAME=slackteam GIT_AUTHOR_EMAIL=slackteam@users.noreply.github.com GIT_COMMITTER_NAME=slackteam GIT_COMMITTER_EMAIL=slackteam@users.noreply.github.com
CMD ["sh", "-c", "gh auth setup-git && node dist/src/index.js"]
