import { buildApp } from "./app";
import { env } from "./env";

const app = buildApp();

app.listen(env.PORT, () => {
  console.log(`[coordinator] listening on :${env.PORT} (${env.NODE_ENV})`);
});
