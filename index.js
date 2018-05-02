require("dotenv").config(); // Load variables from .env into the environment

/** Configuration **/
const websocketPort = 3333; // Port that the websocket server will listen on (For incoming wallet connections)
const webserverPort = 9960; // Port that the webserver will listen on (For receiving new blocks from Nano node)
const statTime = 10; // Seconds between reporting statistics to console (Connected clients, TPS)

const redis = require("redis");
const redisClient = redis.createClient();

/** End Configuration **/

// We don't actually need to talk to Nano, just need the converter
const Nano = require("nanode").Nano;
const nano = new Nano({ url: "http://localhost:9999" });

const express = require("express");
const WebSocketServer = require("uws").Server;
const app = express();
const wss = new WebSocketServer({ port: websocketPort });

const subscriptionMap = {};

// Statistics reporting?
let tpsCount = 0;

app.use((req, res, next) => {
  if (req.headers["content-type"]) return next();
  req.headers["content-type"] = "application/json";
  next();
});
app.use(express.json());
app.post("/api/new-block", (req, res) => {
  res.sendStatus(200);
  console.log(`Received block`);
  tpsCount++;

  const fullBlock = req.body;
  try {
    fullBlock.block = JSON.parse(fullBlock.block);
    fullBlock.block.account = fullBlock.account;
    fullBlock.block.hash = fullBlock.hash;
    fullBlock.block.amount = nano.convert.fromRaw(fullBlock.amount, "mrai");
    saveHashTimestamp(fullBlock.hash);
  } catch (err) {
    return console.log(`Error parsing block data! `, err.message);
  }

  // Special all destination that broadcasts all new blocks
  let destinations = ["all"];

  if (fullBlock.block.type === "state") {
    destinations.push(fullBlock.account);
    console.log(`Got state block: `, fullBlock);
  } else {
    destinations.push(fullBlock.account);
  }

  // Send it to all!
  destinations.forEach(destination => {
    if (!subscriptionMap[destination]) return; // Nobody listening for this

    console.log(`Sending block to ${destination}: `, fullBlock);

    subscriptionMap[destination].forEach(ws => {
      const event = {
        event: "newTransaction",
        data: fullBlock
      };
      ws.send(JSON.stringify(event));
    });
  });
});

app.get("/health-check", (req, res) => {
  res.sendStatus(200);
});

app.listen(webserverPort, () => console.log(`Express server online`));

wss.on("connection", function(ws) {
  ws.subscriptions = [];
  console.log(`Got new connection! `, ws);
  ws.on("message", message => {
    try {
      const event = JSON.parse(message);
      console.log(`Got event`, event);
      parseEvent(ws, event);
    } catch (err) {
      console.log(`Bad message: `, err);
    }
  });
  ws.on("close", event => {
    console.log(`Connection closed, unsubscribing`);
    ws.subscriptions.forEach(account => {
      if (!subscriptionMap[account] || !subscriptionMap[account].length) return; // Not in there for some reason?

      subscriptionMap[account] = subscriptionMap[account].filter(
        subWs => subWs !== ws
      );

      if (subscriptionMap[account].length === 0) {
        delete subscriptionMap[account];
      }
    });
  });
});

async function saveHashTimestamp(hash) {
  console.log(`Saving hash... `, hash);
  const d = new Date();
  try {
    // Get milliseconds in UTC
    redisClient.setnx(`block_timestamp/${hash}`, d.getTime());
  } catch (err) {
    console.log(`Error saving hash timestamp:`, err.message, err);
  }
}

function parseEvent(ws, event) {
  switch (event.event) {
    case "subscribe":
      subscribeAccounts(ws, event.data);
      break;
    case "unsubscribe":
      unsubscribeAccounts(ws, event.data);
      break;
  }
}

function subscribeAccounts(ws, accounts) {
  accounts.forEach(account => {
    if (ws.subscriptions.indexOf(account) !== -1) return; // Already subscribed
    ws.subscriptions.push(account);

    // Add into global map
    if (!subscriptionMap[account]) {
      subscriptionMap[account] = [];
    }

    subscriptionMap[account].push(ws);
  });
}
function unsubscribeAccounts(ws, accounts) {
  accounts.forEach(account => {
    const existingSub = ws.subscriptions.indexOf(account);
    if (existingSub === -1) return; // Not subscribed

    ws.subscriptions.splice(existingSub, 1);

    // Remove from global map
    if (!subscriptionMap[account]) return; // Nobody subscribed to this account?

    const globalIndex = subscriptionMap[account].indexOf(ws);
    if (globalIndex === -1) {
      console.log(
        `Subscribe, not found in the global map?  Potential leak? `,
        account
      );
      return;
    }

    subscriptionMap[account].splice(globalIndex, 1);
  });
}

function printStats() {
  const connectedClients = wss.clients.length;
  const tps = tpsCount / statTime;
  console.log(`Connected clients: ${connectedClients}`);
  console.log(`TPS Average: ${tps}`);
  tpsCount = 0;
}

setInterval(printStats, statTime * 1000); // Print stats every x seconds

console.log(`Websocket server online!`);
