import app from "./app";
import { env } from "./env";

app.listen(env.PORT, () => {
  console.log(`[coordinator] listening on :${env.PORT} (${env.NODE_ENV})`);
});
