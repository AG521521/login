const express = require("express");
const jwt = require("jsonwebtoken");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const SECRET = "your-secret-key-change-this";
const VALID_USERNAME = "admin";
const VALID_PASSWORD = "mypassword123";

app.post("/login", (req, res) => {
  const { username, password } = req.body;
  
  if (username === VALID_USERNAME && password === VALID_PASSWORD) {
    const token = jwt.sign({ username }, SECRET, { expiresIn: "24h" });
    return res.json({ success: true, token });
  }
  
  res.status(401).json({ success: false, message: "用户名或密码错误" });
});

app.get("/verify", (req, res) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ valid: false });
  
  try {
    const decoded = jwt.verify(token, SECRET);
    res.json({ valid: true, username: decoded.username });
  } catch {
    res.status(401).json({ valid: false });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API running on port ${PORT}`));