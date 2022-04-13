FROM node:17.9.0-bullseye

COPY . /app

WORKDIR /app

RUN npm install \
    && mv /app/dat /data \
    && ln -s /data /app/dat ## Assumes /data will store configuration and vaults

VOLUME /data 

ENTRYPOINT ["npm", "run", "dev"]
