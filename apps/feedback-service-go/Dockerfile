FROM docker.io/library/golang:1.26.5-alpine@sha256:0178a641fbb4858c5f1b48e34bdaabe0350a330a1b1149aabd498d0699ff5fb2 AS build

ARG TARGETOS
ARG TARGETARCH

WORKDIR /src
COPY apps/feedback-service-go/go.mod apps/feedback-service-go/go.sum ./
RUN go mod download
COPY apps/feedback-service-go .
RUN target_os="${TARGETOS:-$(go env GOOS)}" \
    && target_arch="${TARGETARCH:-$(go env GOARCH)}" \
    && CGO_ENABLED=0 GOOS="$target_os" GOARCH="$target_arch" go build -buildvcs=false -trimpath \
    -ldflags='-s -w' -o /out/rootfs/app/feedback ./cmd/feedback \
    && mkdir -p /out/rootfs/app/bin /out/rootfs/data/evidence /out/rootfs/data/exports /out/rootfs/data/connector \
    && for entrypoint in \
      feedback-service \
      feedback-notification-worker \
      feedback-export-worker \
      feedback-retention-worker \
      feedback-bootstrap \
      feedback-connector-register \
      feedback-connector-runtime \
      feedback-backup-pull \
      feedback-legacy-migration \
      feedback-migrate; \
    do ln -s ../feedback "/out/rootfs/app/bin/$entrypoint"; done

FROM gcr.io/distroless/static-debian12:nonroot@sha256:f5b485ea962d9bd1186b2f6b3a061191539b905b82ec395de78cbfae51f20e35

ARG VERSION=0.1.0-alpha.1
ARG REVISION=unknown
LABEL org.opencontainers.image.title="Feedback Service Go" \
      org.opencontainers.image.version="$VERSION" \
      org.opencontainers.image.revision="$REVISION" \
      org.opencontainers.image.source="https://github.com/geibee/gis-example"

COPY --from=build --chown=65532:65532 /out/rootfs/ /

USER 65532:65532
EXPOSE 8090
CMD ["/app/bin/feedback-service"]
