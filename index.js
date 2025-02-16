const express = require("express");
const PaymentController = require("./controllers/payment");
const swaggerUi = require("swagger-ui-express");
const swaggerJsdoc = require("swagger-jsdoc");
const fs = require('fs');


const app = express();
app.use(express.json());
// Serve static files from the 'web' directory
app.use(express.static('web'));

// Route for the root path to serve index.html
app.get('/', (req, res) => {res.sendFile('index.html', { root: './web' })});
app.get('/idx3', (req, res) => {res.sendFile('index3.html', { root: './web' })});

// Swagger definition
const swaggerOptions = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "Payment Aggregator API",
      version: "1.0.0",
      description: "Payment processing system API documentation",
    },
    servers: [
      {
        url: "http://localhost:5000",
        description: "Development server",
      },
    ],
  },
  apis: ["./index.js", "./controllers/*.js"], // Path to the API docs
};

const swaggerSpec = swaggerJsdoc(swaggerOptions);
fs.writeFileSync('swagger.json', JSON.stringify(swaggerSpec, null, 2));
app.use("/swag", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

const paymentController = new PaymentController();

app.post("/api/config", (req, res) => paymentController.setConfigs(req, res));
app.post("/api/merchants", (req, res) => paymentController.addMerchant(req, res));
app.post("/api/payments", (req, res) =>paymentController.createPayment(req, res));
app.post("/api/payments/process", (req, res) =>paymentController.processPayments(req, res));
app.post("/api/payments/execute", (req, res) =>paymentController.executePayments(req, res));
app.post("/api/payouts", (req, res) =>paymentController.processPayout(req, res));

app.get("/api/merchants", (req, res) => paymentController.listMerchants(req, res));
app.get("/api/payments", (req, res) => paymentController.listPayments(req, res));
app.get("/api/config", (req, res) => paymentController.getConfig(req, res));

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: "Something went wrong!" });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`FE available at http://localhost:${PORT}/`);
  console.log(`Swagger available at http://localhost:${PORT}/swag`);
});
