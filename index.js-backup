const axios = require("axios");
const _http_base = require("homebridge-http-base");
const PullTimer = _http_base.PullTimer;

let Service, Characteristic;

module.exports = function (homebridge) {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  homebridge.registerAccessory("homebridge-tesy-heater-v2", "TesyHeater", TesyHeater);
};

class TesyHeater {
  constructor(log, config) {
    this.log = log;
    this.name = config.name;
    this.manufacturer = config.manufacturer || "Tesy";
    this.model = config.model || "Convector (Heater)";
    this.device_id = config.device_id;
    this.pullInterval = config.pullInterval || 10000;
    this.maxTemp = config.maxTemp || 30;
    this.minTemp = config.minTemp || 10;
    this.username = config.username || null;
    this.password = config.password || null;
    this.session = "";
    this.alt = "";

    if (this.username && this.password) {
      this.authenticate();
    }

    this.service = new Service.HeaterCooler(this.name);
    this.pullTimer = new PullTimer(
      this.log,
      this.pullInterval,
      this.refreshTesyHeaterStatus.bind(this),
      () => {}
    );
    this.pullTimer.start();
  }

  async authenticate() {
    try {
      const response = await axios.post("https://v4.mytesy.com/auth/login", {
        email: this.username,
        password: this.password,
      });
      this.session = response.data.session_token;
      this.alt = response.data.alt_key;
      this.log.info("Successfully authenticated with Tesy API");
    } catch (error) {
      this.log.error("Authentication failed:", error.response?.data || error.message);
    }
  }

  async refreshTesyHeaterStatus() {
    this.log.debug("Refreshing heater status");
    try {
      const response = await axios.post("https://v4.mytesy.com/devices/status", {
        session_token: this.session,
        device_id: this.device_id,
      });

      const status = response.data.device_status;
      this.updateDeviceStatus(status);
    } catch (error) {
      this.log.error("Failed to refresh heater status:", error.response?.data || error.message);
    }
  }

  updateDeviceStatus(status) {
    const newCurrentTemperature = parseFloat(status.temperature);
    this.service.getCharacteristic(Characteristic.CurrentTemperature).updateValue(newCurrentTemperature);

    const newHeatingThresholdTemperature = parseFloat(status.target_temperature);
    this.service.getCharacteristic(Characteristic.HeatingThresholdTemperature).updateValue(newHeatingThresholdTemperature);

    const isActive = status.power === "on" ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE;
    this.service.getCharacteristic(Characteristic.Active).updateValue(isActive);
  }

  async setActive(value, callback) {
    this.log.info("Setting heater state:", value);
    try {
      await axios.post("https://v4.mytesy.com/devices/set", {
        session_token: this.session,
        device_id: this.device_id,
        command: "power",
        value: value === 0 ? "off" : "on",
      });
      callback(null, value);
    } catch (error) {
      this.log.error("Failed to set heater state:", error.response?.data || error.message);
      callback(error);
    }
  }

  async setHeatingThresholdTemperature(value, callback) {
    this.log.info("Setting target temperature to:", value);
    try {
      await axios.post("https://v4.mytesy.com/devices/set", {
        session_token: this.session,
        device_id: this.device_id,
        command: "target_temperature",
        value: value,
      });
      callback(null, value);
    } catch (error) {
      this.log.error("Failed to set target temperature:", error.response?.data || error.message);
      callback(error);
    }
  }

  getServices() {
    this.informationService = new Service.AccessoryInformation();
    this.informationService
      .setCharacteristic(Characteristic.Manufacturer, this.manufacturer)
      .setCharacteristic(Characteristic.Model, this.model)
      .setCharacteristic(Characteristic.SerialNumber, this.device_id);

    this.service.getCharacteristic(Characteristic.Active)
      .on("set", this.setActive.bind(this));

    this.service.getCharacteristic(Characteristic.CurrentTemperature)
      .setProps({ minStep: 0.1 });

    this.service.getCharacteristic(Characteristic.HeatingThresholdTemperature)
      .setProps({
        minValue: this.minTemp,
        maxValue: this.maxTemp,
        minStep: 0.5,
      })
      .on("set", this.setHeatingThresholdTemperature.bind(this));

    return [this.informationService, this.service];
  }
}
