FROM gradle:8.10-jdk21 AS build

WORKDIR /src
COPY . .
RUN gradle installDist --no-daemon

FROM eclipse-temurin:21-jre

WORKDIR /app
COPY --from=build /src/build/install/feedback-service /app
RUN mkdir -p /data/evidence && chown -R 65532:65532 /data
USER 65532:65532
EXPOSE 8090

CMD ["/app/bin/feedback-service"]
