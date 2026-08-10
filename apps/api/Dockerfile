FROM docker.io/library/gradle:8.10-jdk21 AS build

WORKDIR /src
COPY . .
RUN gradle installDist --no-daemon

FROM docker.io/library/eclipse-temurin:21-jre

WORKDIR /app
COPY --from=build /src/build/install/web-gis-api /app
EXPOSE 8080

CMD ["/app/bin/web-gis-api"]
