require('dotenv').config({ override: true });
const masked = (process.env.DATABASE_URL || '').replace(/:\/\/([^:]+):([^@]+)@/, '://$1:***@');
console.log('DATABASE_URL =>', masked);

const app = require('./app');

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`API running on port ${PORT}`));
