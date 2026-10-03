import { rm } from "node:fs/promises";
export default async function cleanup() {
  const root = process.env.CTD_E2E_ROOT;
  if (root) await rm(root, { recursive: true, force: true });
}
