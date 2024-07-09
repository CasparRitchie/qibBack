require('dotenv').config();

const express = require('express');
const { Pool } = require('pg');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const multer = require('multer');
const multerS3 = require('multer-s3');

const app = express();
const port = process.env.PORT || 3000;

// Database configuration
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// S3 configuration
const s3Client = new S3Client({
  region: 'us-east-1', // Replace with your region
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

const upload = multer({
  storage: multerS3({
    s3: s3Client,
    bucket: process.env.S3_BUCKET_NAME,
    key: (req, file, cb) => {
      cb(null, `uploads/${file.originalname}`);
    }
  })
});

// Test database connection
app.get('/db', async (req, res) => {
  try {
    const client = await pool.connect();
    const result = await client.query('SELECT NOW()');
    res.json(result.rows[0]);
    client.release();
  } catch (err) {
    console.error(err);
    res.send('Error ' + err);
  }
});

// Upload file
app.post('/upload', upload.single('file'), async (req, res) => {
  res.send(`File uploaded successfully: ${req.file.location}`);
});

app.listen(port, () => {
  console.log(`App running on port ${port}.`);
});
