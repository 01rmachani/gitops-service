const express = require('express');
const path = require('path');
const app = express();

app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'presentation.html'));
});

const PORT = 38080;
app.listen(PORT, () => {
    console.log(`Presentation server running at http://localhost:${PORT}`);
});
