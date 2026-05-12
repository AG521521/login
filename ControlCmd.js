const mongoose = require('mongoose');

const controlCmdSchema = new mongoose.Schema({
    relay1: Number,
    relay2: Number,
    relay3: Number,
    relay4: Number,
    mode: String,
    status: { type: String, enum: ['pending', 'executed'], default: 'pending' },
    createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('ControlCmd', controlCmdSchema);
