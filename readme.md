> [!IMPORTANT]  
> The project has been integrated into [LiveSync Bridge](https://github.com/vrtmrz/livesync-bridge), and will be no longer maintained.
> If you have any ideas or problems, please do not hesitate to let us know as a new request for LiveSync-Bridge.

# FileSystem-LiveSync

The synchronization daemon between filesystem and CouchDB compatible with [Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync).

Notice: **We're on the bleeding edge.** Please make sure to back your vault up!

Now compatible with Self-hosted LiveSync 0.13.0 or above.

## How to run

```sh
git clone --recursive https://github.com/vrtmrz/filesystem-livesync
cp dat/config.sample.json dat/config.json
# Setting up configuration
vi dat/config.json
npm i -D
npm run dev
```

## Configuration

The configuration file consists of the following structure.

```jsonc
{
    // "config_1" is just the name for identifying the connection.
    "config_1": {
        "server": {
            "uri": "http://localhost:5984/private1_vault",
            "auth": {
                "username": "username_of_private_vault",
                "password": "password_of_private_vault",
                "passphrase": "passphrase_of_private_vault" // Remove if no passphrase is set for your vault
            },
            "path": "shared/", // All documents under this path will synchronized.
            "initialScan": false // If you enable this, all server files will be synchronized to local storage once when daemon has been started.
        },
        "local": {
            "path": "./vault",
            "processor": "utils/build.sh", // If you want to run some program after synchronization has been stablized, you can set this.
            "initialScan": false // If you enable this, all files on the local storage will be synchronized to server once when daemon has been started.
        },
        "auto_reconnect": true,
        "sync_on_connect": true // This means both server.initialScan + local.initialScan.
    }
}

```
