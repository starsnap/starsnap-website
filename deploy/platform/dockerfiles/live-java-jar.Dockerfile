FROM docker.io/library/eclipse-temurin:21-jdk@sha256:85f00967bcc624fc19fa9c2cf124ea426a5363898e267141726f31f358c2e14b

WORKDIR /app

ARG APP_PORT
ARG JAR_NAME
ENV JAR_NAME=${JAR_NAME}

COPY application.jar /app/${JAR_NAME}

EXPOSE ${APP_PORT}

ENTRYPOINT ["sh", "-ec", "exec java -jar /app/$JAR_NAME"]
