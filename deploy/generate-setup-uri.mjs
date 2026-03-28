#!/usr/bin/env node
/**
 * Generate a LiveSync Setup URI for easy Obsidian configuration.
 *
 * Reads from environment variables:
 *   hostname, username, password, database, passphrase, uri_passphrase (optional)
 */

import { encrypt } from "octagonal-wheels/encryption/encryption";

const nouns = ["waterfall","river","breeze","moon","rain","wind","sea","morning","snow","lake","sunset","pine","shadow","leaf","dawn","forest","hill","cloud","meadow","glade","bird","brook","butterfly","dew","field","flower","firefly","grass","haze","mountain","night","pond","snowflake","silence","sky","thunder","violet","wildflower","wave","dream","cherry","tree","fog","frost","star"];
const adjectives = ["autumn","hidden","bitter","misty","silent","empty","dry","dark","summer","icy","delicate","quiet","white","cool","spring","winter","patient","twilight","crimson","wispy","weathered","blue","billowing","broken","cold","frosty","green","long","lingering","bold","little","morning","old","red","still","small","sparkling","shy","wandering","withered","wild","young","holy","solitary","fragrant","aged","snowy","proud","ancient","purple","lively","nameless"];

function friendlyString() {
    const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
    const noun = nouns[Math.floor(Math.random() * nouns.length)];
    return `${adj}-${noun}`;
}

const uriPassphrase = process.env.uri_passphrase || friendlyString();

const conf = {
    couchDB_URI: process.env.hostname,
    couchDB_USER: process.env.username,
    couchDB_PASSWORD: process.env.password,
    couchDB_DBNAME: process.env.database || "obsidian",
    syncOnStart: true,
    gcDelay: 0,
    periodicReplication: true,
    syncOnFileOpen: true,
    encrypt: !!process.env.passphrase,
    passphrase: process.env.passphrase || "",
    usePathObfuscation: !!process.env.passphrase,
    batchSave: true,
    batch_size: 50,
    batches_limit: 50,
    useHistory: true,
    disableRequestURI: true,
    customChunkSize: 50,
    syncAfterMerge: false,
    concurrencyOfReadChunksOnline: 100,
    minimumIntervalOfReadChunksOnline: 100,
    handleFilenameCaseSensitive: false,
    doNotUseFixedRevisionForChunks: false,
    settingVersion: 10,
    notifyThresholdOfRemoteStorageSize: 800,
};

const encryptedConf = encodeURIComponent(await encrypt(JSON.stringify(conf), uriPassphrase, false));
const setupURI = `obsidian://setuplivesync?settings=${encryptedConf}`;

console.log(`URI Passphrase: ${uriPassphrase}`);
console.log(setupURI);
