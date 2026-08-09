FROM eclipse-temurin:21-jdk AS build

WORKDIR /repo
COPY apps/feedback-service apps/feedback-service
COPY contracts/feedback/kotlin contracts/feedback/kotlin
RUN cd apps/feedback-service && ./gradlew installDist --no-daemon

FROM eclipse-temurin:21-jre

WORKDIR /app
COPY --from=build /repo/apps/feedback-service/build/install/feedback-service /app
RUN mkdir -p /data/evidence /data/exports && chown -R 65532:65532 /data
USER 65532:65532
EXPOSE 8090

CMD ["/app/bin/feedback-service"]
