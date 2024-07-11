FROM oven/bun:alpine

WORKDIR /srv
COPY bun.lockb package.json /srv/
RUN bun install --production

COPY . /srv
CMD ["bun", "server.ts"]