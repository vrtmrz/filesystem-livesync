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
                "username": "couch_db_username",
                "password": "couch_db_password",
                "passphrase": "passphrase_of_private_vault"
            },
            "path": "shared/"
        },
        "local": {
            "path": "/data/vault1",
            "processor": "utils/build.sh",
            "initialScan": false
        },
        "auto_reconnect": true
    }
}
```

## Run the image:

```
docker run -it --rm -v /tmp/data:/data filesystem-livesync
```
