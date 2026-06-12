// Vercel serverless entrypoint — vercel.json rewrites every path here, and
// the Express app does its own routing.
import { buildApp } from "../src/app";

export default buildApp();
