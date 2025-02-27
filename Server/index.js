const express = require("express");
const axios = require("axios");
const bodyParser = require("body-parser");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const CronJob = require("cron").CronJob;
const dotenv = require("dotenv");
const path = require("path");
const Papa = require("papaparse"); // To parse CSV
const { saveAnalysisToDb, savePatientSentiment } = require("./dbUtils");
const { loginToInstagram, postToInstagram } = require("./src/instagram/index.js");

dotenv.config();

const app = express();

// Use CORS with specific configuration
app.use(
  cors({
    origin: "http://localhost:3000",
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true,
  })
);

app.use(bodyParser.json());

// Define storage for dataset uploads
const upload1 = multer({
  dest: path.join(__dirname, "uploads"),
});

// Environment variables for IBM Watson API
const API_KEY = process.env.IBM_WATSON_API_KEY;
const INSTANCE_URL = process.env.IBM_WATSON_URL;

if (!API_KEY || !INSTANCE_URL) {
  throw new Error("IBM API key or URL is not set in the environment variables");
}

// Function to analyse sentiment
const analyzeSentiment = async (text) => {
  const requestData = {
    text,
    features: {
      sentiment: {
        document: true,
      },
    },
  };

  try {
    const response = await axios.post(
      `${INSTANCE_URL}/v1/analyze?version=2019-07-12`,
      requestData,
      {
        headers: { "Content-Type": "application/json" },
        auth: {
          username: "apikey",
          password: API_KEY,
        },
      }
    );
    return response.data.sentiment.document.label;
  } catch (error) {
    console.error("Error in Sentiment Analysis:", error.message);
    throw error.response ? error.response.data : error.message;
  }
};

// Function to analyse emotions
const analyzeEmotions = async (text) => {
  const requestData = {
    text,
    features: {
      emotion: {
        document: true,
      },
    },
  };

  try {
    const response = await axios.post(
      `${INSTANCE_URL}/v1/analyze?version=2019-07-12`,
      requestData,
      {
        headers: { "Content-Type": "application/json" },
        auth: {
          username: "apikey",
          password: API_KEY,
        },
      }
    );
    return response.data.emotion.document.emotion;
  } catch (error) {
    console.error("Error in Emotion Analysis:", error.message);
    throw error.response ? error.response.data : error.message;
  }
};


// Instagram login endpoint
app.post("/api/instagram/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res
      .status(400)
      .json({ error: "Username and password are required." });
  }

  const result = await loginToInstagram(username, password);

  if (result.success) {
    res.json({ message: `Logged in as ${result.username}` });
  } else {
    res.status(401).json({ error: result.error });
  }
});

// Cron job for scheduled Instagram posts
const cronInsta = new CronJob("0 0 * * *", async () => {
  console.log("Starting scheduled Instagram post...");
  await postToInstagram("username", "password"); // Replace with real credentials
});

cronInsta.start();

// Instagram post endpoint
app.post("/api/instagram/post", async (req, res) => {
  const { username, password, imageUrl, caption } = req.body;
  console.log("Data received for Instagram post:", {
    username,
    password,
    imageUrl,
    caption,
  });

  if (!username || !password || !imageUrl || !caption) {
    return res.status(400).json({ error: "All fields are required." });
  }

  try {
    const result = await postToInstagram(username, password, imageUrl, caption);
    if (result.success) {
      res.json({ message: "Post uploaded successfully!" });
    } else {
      res.status(500).json({ error: "Failed to upload post." });
    }
  } catch (error) {
    console.error("Error uploading post:", error.message);
    res
      .status(500)
      .json({ error: "An error occurred while uploading the post." });
  }
});

// Endpoint to perform sentiment and emotion analysis
app.post("/api/analyze", async (req, res) => {
  const { feeling, challenge, improve, checkCaption } = req.body;

  if (!feeling && !challenge && !improve && !checkCaption) {
    return res
      .status(400)
      .json({ error: "Input text is required for analysis." });
  }

  const combinedStatement =
    checkCaption || `${feeling}. ${challenge}. ${improve}`;

  try {
    const sentiment = await analyzeSentiment(combinedStatement);
    const emotions = await analyzeEmotions(combinedStatement);
    await saveAnalysisToDb(combinedStatement, sentiment, emotions);
    res.status(200).json({
      combinedStatement,
      sentiment,
      emotions,
    });
  } catch (error) {
    console.error("Error in Analysis:", error);
    res.status(500).json({
      error: "Failed to process analysis.",
      details: error,
    });
  }
});

// Predict sentiment and emotions endpoint
app.post("/api/predict", async (req, res) => {
  const { feeling, challenge, improve, checkCaption } = req.body;

  try {
    const combinedStatement =
      checkCaption || `${feeling}. ${challenge}. ${improve}`;

    const sentiment = await analyzeSentiment(combinedStatement);
    const emotions = await analyzeEmotions(combinedStatement);
    await saveAnalysisToDb(combinedStatement, sentiment, emotions);
    res.json({ combinedStatement, sentiment, emotions });
  } catch (error) {
    console.error("Error in analysis:", error.message);
    res.status(500).json({ error: "Failed to process the analysis." });
  }
});

// Predict sentiments for CSV data
app.post("/api/predictPatientsSentiments", async (req, res) => {
  const csvData = req.body.csvData;

  if (!csvData || csvData.length === 0) {
    return res.status(400).json({ error: "CSV data is empty or missing." });
  }

  const results = [];

  for (const row of csvData) {
    const {
      Name: name,
      Age: age,
      Sentiment: sentimentInput,
      Type: type,
      Country: country,
      City: city,
      State: state,
      Gender: gender,
    } = row;

    try {
      const sentiment = await analyzeSentiment(sentimentInput);
      const emotions = await analyzeEmotions(sentimentInput);
      await savePatientSentiment(
        name,
        age,
        sentiment,
        emotions,
        type,
        country,
        city,
        state,
        gender
      );

      results.push({
        name,
        age,
        sentiment,
        emotions,
        type,
        country,
        city,
        state,
        gender,
      });
    } catch (error) {
      console.error(`Error processing row for ${name}:`, error.message);
      results.push({
        name,
        age,
        sentiment: "Error processing sentiment",
        emotions: null,
        type,
        country,
        city,
        state,
        gender,
      });
    }
  }

  console.log("Processed Results:", results);
  res.json(results);
});

// File upload handling for audio transcription
const upload = multer({ dest: "uploads/" });

app.post("/transcribe", upload.single("audio"), async (req, res) => {
  const audioFile = req.file;

  if (!audioFile) {
    return res.status(400).json({ error: "No audio file uploaded" });
  }

  try {
    const audioData = fs.readFileSync(audioFile.path);
    const response = await axios.post(
      `${INSTANCE_URL}/v1/recognize`,
      audioData,
      {
        headers: { "Content-Type": audioFile.mimetype },
        auth: { username: "apikey", password: API_KEY },
      }
    );

    res.json(response.data);
  } catch (error) {
    console.error("Error transcribing audio:", error.message);
    res.status(500).json({ error: "Failed to transcribe audio" });
  } finally {
    fs.unlink(audioFile.path, (err) => {
      if (err) console.error("Error cleaning up file:", err);
    });
  }
});

// New endpoint to upload a dataset (CSV file) for processing
app.post("/api/uploadDataset", upload1.single("dataset"), (req, res) => {
  const csvFile = req.file;

  if (!csvFile) {
    return res.status(400).json({ error: "No dataset file uploaded." });
  }

  try {
    const fileData = fs.readFileSync(csvFile.path, "utf8");

    Papa.parse(fileData, {
      header: true,
      complete: async function (results) {
        const data = results.data;
        // Process the data as needed; here the parsed data is simply returned.
        res.json({ data });
        fs.unlink(csvFile.path, (err) => {
          if (err) console.error("Error cleaning up dataset file:", err);
        });
      },
      error: function (error) {
        res.status(500).json({ error: "Error parsing CSV file.", details: error });
        fs.unlink(csvFile.path, (err) => {
          if (err) console.error("Error cleaning up dataset file:", err);
        });
      },
    });
  } catch (error) {
    console.error("Error handling dataset file:", error.message);
    res.status(500).json({ error: "Failed to process dataset file" });
  }
});

app.listen(3000, () => {
  console.log("Node.js server is running on port 3000");
});
