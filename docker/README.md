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
                "passphrase": ""
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
