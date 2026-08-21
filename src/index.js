import express from "express";
import maintenanceTriageRouter from "./routes/maintenanceTriage.js";

const app = express();
app.use(express.json());
app.use("/", maintenanceTriageRouter);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`maintenance-triage API listening on :${PORT}`);
});
