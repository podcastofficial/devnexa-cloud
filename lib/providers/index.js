const adapters = { vercel: require("./vercel"), cloudflare: require("./cloudflare"), netlify: require("./netlify") };
const CONNECTABLE = Object.keys(adapters);
const DEPLOYABLE = Object.keys(adapters); // all three now have deploy + refresh
module.exports = { adapters, CONNECTABLE, DEPLOYABLE };
