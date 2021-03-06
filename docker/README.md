## Build the image:

From the root directory of the [vrtmrz/filesystem-livesync](https://github.com/vrtmrz/filesystem-livesync) repository run the following to build the image:

```
docker build -t filesystem-livesync -f docker/Dockerfile .
```

## Configure the image:

Assuming a folder at `/tmp/data` was going to store your config and vaults, write the following to `/tmp/data/config.json`:

```
{
    "config_1": {
        "server": {
            "uri": "http://example-uri/private1_vault",
            "auth": {
                "username": "couchdb_username",
                "password": "couchdb_password",
                "passphrase": "mypassphrase" // Remove if no passphrase is set for Vault
            },
            "initialScan": true 
        },
        "local": {
            "path": "/data/vault1",
            "initialScan": true 
        },
        "auto_reconnect": true,
        "sync_on_connect": true 
    }
}
```

## Run the image:

```
docker run -it --rm -v /tmp/data:/data filesystem-livesync
```

If you would like to be able to edit files from your host running Docker, it is recommended to set the `CHOKIDAR_USEPOLLING` environment variable to equal `1`:

```
docker run -it --rm -v /tmp/data:/data -e CHOKIDAR_USEPOLLING=1 filesystem-livesync
```
