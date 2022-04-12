import { LOG_LEVEL } from "./types";

// eslint-disable-next-line require-await
export let Logger: (message: any, level?: LOG_LEVEL) => void = (message, _) => {
    const timestamp = new Date().toLocaleString();
    const messagecontent = typeof message == "string" ? message : message instanceof Error ? `${message.name}:${message.message}` : JSON.stringify(message, null, 2);
    const newmessage = timestamp + "->" + messagecontent;
    console.log(newmessage);
};

export function setLogger(loggerFun: (message: any, level?: LOG_LEVEL) => Promise<void>) {
    Logger = loggerFun;
}
