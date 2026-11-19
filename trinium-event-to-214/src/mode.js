// PROCESSING_MODE switches the whole I/O layer of the service:
//   local (default) - local folders only, no SFTP, no Kafka. Safe for dev/tests.
//   kafka           - Trinium SFTP is the file source/target and Kafka is the message bus.
//                     Everything is still stored locally/in the DB too, so payloads can be validated.
export function processingMode(env = process.env) {
  const m = (env.PROCESSING_MODE || 'local').trim().toLowerCase();
  if (m !== 'local' && m !== 'kafka') throw new Error(`PROCESSING_MODE must be "local" or "kafka", got "${env.PROCESSING_MODE}"`);
  return m;
}
export const isKafkaMode = () => processingMode() === 'kafka';
