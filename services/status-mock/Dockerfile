FROM eclipse-temurin:17-jdk AS build
WORKDIR /src
COPY . .
RUN ./gradlew --no-daemon installDist

FROM eclipse-temurin:17-jre
WORKDIR /srv
COPY --from=build /src/build/install/play-right-demo/lib ./lib
USER 10001:10001
EXPOSE 8081
CMD ["java", "-cp", "/srv/lib/*", "dev.playrightdemo.demo.statusmock.StatusMock"]
