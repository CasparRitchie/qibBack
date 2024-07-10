require('dotenv').config();

const express = require('express');
const mysql = require('mysql2/promise');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const multer = require('multer');
const multerS3 = require('multer-s3');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;

// Enable CORS for all routes
app.use(cors({
  origin: 'http://localhost:3000', // Adjust to your frontend URL
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

app.use(express.json()); // Ensure that JSON payloads are parsed

console.log("Environment Variables Loaded:");
console.log("AWS_ACCESS_KEY_ID:", process.env.AWS_ACCESS_KEY_ID);
console.log("AWS_SECRET_ACCESS_KEY:", process.env.AWS_SECRET_ACCESS_KEY);
console.log("S3_BUCKET_NAME:", process.env.S3_BUCKET_NAME);
console.log("DATABASE_URL:", process.env.DATABASE_URL);
console.log("JWT_SECRET:", process.env.JWT_SECRET);

// Check if JWT_SECRET is set
if (!process.env.JWT_SECRET) {
  console.error("JWT_SECRET is not set. Please set it in the environment variables.");
  process.exit(1);
}

// Middleware for Protecting Routes
const auth = (req, res, next) => {
  const token = req.header('Authorization').replace('Bearer ', '');
  if (!token) {
    return res.status(401).send('Access denied');
  }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).send('Invalid token');
  }
};

// Load RDS SSL Certificate (only if SSL is required)
let sslCert;
try {
  sslCert = fs.readFileSync(path.resolve(__dirname, 'rds-combined-ca-bundle.pem'));
} catch (err) {
  console.log("SSL certificate not found, proceeding without SSL");
}

// Database configuration
const poolConfig = {
  uri: process.env.DATABASE_URL,
  ssl: sslCert ? { ca: sslCert } : false,
};

let pool;
try {
  pool = mysql.createPool(poolConfig);
  console.log("Database connection pool created successfully.");
} catch (err) {
  console.error("Error creating database connection pool:", err);
  process.exit(1);
}

// S3 configuration
let s3Client;
try {
  s3Client = new S3Client({
    region: 'eu-north-1', // Replace with your bucket's region
    endpoint: 'https://s3.eu-north-1.amazonaws.com', // Use the correct endpoint for your bucket's region
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
  });
  console.log("S3 client created successfully.");
} catch (err) {
  console.error("Error creating S3 client:", err);
  process.exit(1);
}

const upload = multer({
  storage: multerS3({
    s3: s3Client,
    bucket: process.env.S3_BUCKET_NAME,
    key: (req, file, cb) => {
      const s3Key = `uploads/${Date.now()}_${file.originalname}`;
      cb(null, s3Key);
    }
  })
});

// Test database connection
app.get('/db', async (req, res) => {
  try {
    const connection = await pool.getConnection();
    const [rows] = await connection.query('SELECT NOW()');
    res.json(rows[0]);
    connection.release();
  } catch (err) {
    console.error(err);
    res.send('Error ' + err);
  }
});

// Upload file and save metadata
app.post('/upload', auth, upload.single('file'), async (req, res) => {
  const file = req.file;
  const s3Key = file.key;
  const { production_id, version } = req.body; // Add these fields in the request body

  try {
    const connection = await pool.getConnection();
    const query = 'INSERT INTO documents (production_id, file_name, s3_key, version) VALUES (?, ?, ?, ?)';
    await connection.query(query, [production_id, file.originalname, s3Key, version]);
    connection.release();

    res.send(`File uploaded successfully: ${file.location}`);
  } catch (err) {
    console.error(err);
    res.send('Error ' + err);
  }
});

// List all documents
app.get('/documents', auth, async (req, res) => {
  try {
    const connection = await pool.getConnection();
    const [rows] = await connection.query('SELECT * FROM documents');
    connection.release();
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.send('Error ' + err);
  }
});

// Download a file
app.get('/download/:id', auth, async (req, res) => {
  const documentId = req.params.id;

  try {
    const connection = await pool.getConnection();
    const [rows] = await connection.query('SELECT * FROM documents WHERE id = ?', [documentId]);
    connection.release();
    if (rows.length === 0) {
      return res.status(404).send('Document not found');
    }
    const document = rows[0];
    const getObjectParams = {
      Bucket: process.env.S3_BUCKET_NAME,
      Key: document.s3_key
    };
    const command = new GetObjectCommand(getObjectParams);
    const s3Stream = await s3Client.send(command);
    res.attachment(document.file_name);
    s3Stream.Body.pipe(res);
  } catch (err) {
    console.error(err);
    res.send('Error ' + err);
  }
});

// Status page route
app.get('/status', async (req, res) => {
  try {
    const connection = await pool.getConnection();
    const [tables] = await connection.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'quartzib'
    `);

    console.log("Tables retrieved:", tables);

    let statusReport = '<h1>Database Status</h1>';

    for (const table of tables) {
      console.log(`Processing table: ${table.TABLE_NAME}`);
      statusReport += `<h2>Table: ${table.TABLE_NAME}</h2>`;
      const [tableData] = await connection.query(`SELECT * FROM quartzib.${table.TABLE_NAME}`);
      statusReport += '<pre>' + JSON.stringify(tableData, null, 2) + '</pre>';
    }

    connection.release();
    res.send(statusReport);
  } catch (err) {
    console.error(err);
    res.send('Error ' + err);
  }
});

// Registration Route
app.post('/register', async (req, res) => {
  const { username, password, company_id } = req.body;
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const connection = await pool.getConnection();
    const query = 'INSERT INTO users (username, password, company_id) VALUES (?, ?, ?)';
    await connection.query(query, [username, hashedPassword, company_id]);
    connection.release();
    res.status(201).send('User registered');
  } catch (err) {
    res.status(400).send(err.message);
  }
});

// Login Route
app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const connection = await pool.getConnection();
    const [rows] = await connection.query('SELECT * FROM users WHERE username = ?', [username]);
    connection.release();
    if (rows.length === 0) {
      return res.status(401).send('Invalid credentials');
    }
    const user = rows[0];
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return res.status(401).send('Invalid credentials');
    }
    const token = jwt.sign({ id: user.id, company_id: user.company_id }, process.env.JWT_SECRET, { expiresIn: '1h' });
    res.send({ token });
  } catch (err) {
    res.status(400).send(err.message);
  }
});

app.listen(port, () => {
  console.log(`App running on port ${port}.`);
});
