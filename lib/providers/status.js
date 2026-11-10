// Normalizes provider-specific deployment states to: queued | building | ready | error | canceled
const MAP = {
  ready: "ready", success: "ready",
  error: "error", failed: "error", failure: "error", rejected: "error",
  canceled: "canceled", cancelled: "canceled",
  building: "building", active: "building", in_progress: "building", initializing: "building",
  uploading: "building", uploaded: "building", preparing: "building", prepared: "building",
  processing: "building", processed: "building", retrying: "building",
  queued: "queued", enqueued: "queued", new: "queued", idle: "queued", pending: "queued"
};

function normalizeStatus(raw) {
  return MAP[String(raw || "").toLowerCase()] || "queued";
}

function projectStatusFor(deploymentStatus) {
  return deploymentStatus === "ready" ? "live" : deploymentStatus === "error" ? "failed" : "deploying";
}

module.exports = { normalizeStatus, projectStatusFor };
