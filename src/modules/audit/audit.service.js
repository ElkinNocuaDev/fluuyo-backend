const { pool } = require('../../db');

async function writeAuditLog({
  actorUserId = null,
  action,
  entityType = null,
  entityId = null,
  before = null,
  after = null,
  ip = null,
  userAgent = null,
}) {
  await pool.query(
    `
    INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, before, after, ip, user_agent)
    VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::inet, $8)
    `,
    [
      actorUserId,
      action,
      entityType,
      entityId,
      before ? JSON.stringify(before) : null,
      after ? JSON.stringify(after) : null,
      ip,
      userAgent,
    ]
  );
}

module.exports = { writeAuditLog };
