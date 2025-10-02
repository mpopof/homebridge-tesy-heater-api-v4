// index.js
const axios = require("axios");
const _http_base = require("homebridge-http-base");
const PullTimer = _http_base.PullTimer;

let Service, Characteristic;

module.exports = function (homebridge) {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  // Keep the package name here in case you want to fully-qualify in config:
  homebridge.registerAccessory("homebridge-tesy-heater-api-v4", "TesyHeater", TesyHeater);
};

class TesyHeater {
  constructor(log, config) {
    this.log = log;

    // ---- Config ----
    this.name = config.name;
    this.manufacturer = config.manufacturer || "Tesy";
    this.model = config.model || "Convector (Heater)";
    this.device_id = config.device_id;
    this.pullInterval = config.pullInterval || 10000;
    this.maxTemp = config.maxTemp || 30;
    this.minTemp = config.minTemp || 10;

    this.userid = config.userid || null;   // optional; some accounts have it
    this.username = config.username || null;
    this.password = config.password || null;

    // ---- Session state returned by login ----
    this.session = ""; // PHPSESSID / acc_session
    this.alt = "";     // ALT / acc_alt

    // ---- HomeKit Service ----
    this.service = new Service.HeaterCooler(this.name);

    // Default initial states so Home app doesn't show "No Response" before first refresh
    this.service
      .getCharacteristic(Characteristic.CurrentHeaterCoolerState)
      .updateValue(Characteristic.CurrentHeaterCoolerState.INACTIVE);

    this.service
      .getCharacteristic(Characteristic.Active)
      .updateValue(Characteristic.Active.INACTIVE);

    this.service
      .getCharacteristic(Characteristic.CurrentTemperature)
      .updateValue(this.minTemp);

    this.service
      .getCharacteristic(Characteristic.HeatingThresholdTemperature)
      .setProps({
        minValue: this.minTemp,
        maxValue: this.maxTemp,
        minStep: 0.5,
      })
      .updateValue(this.minTemp);

    // Add CoolingThresholdTemperature so Home shows the marker on the wheel
    this.service
      .getCharacteristic(Characteristic.CoolingThresholdTemperature)
      .setProps({
        minValue: this.minTemp,
        maxValue: this.maxTemp,
        minStep: 0.5,
      })
      .updateValue(this.minTemp);

    // Only support HEAT for TargetHeaterCoolerState
    this.service
      .getCharacteristic(Characteristic.TargetHeaterCoolerState)
      .setProps({
        validValues: [Characteristic.TargetHeaterCoolerState.HEAT],
      });

    // ---- Bind getters/setters ----
    this.service
      .getCharacteristic(Characteristic.Active)
      .on("get", this.getActive.bind(this))
      .on("set", this.setActive.bind(this));

    this.service
      .getCharacteristic(Characteristic.CurrentTemperature)
      .setProps({ minStep: 0.1 })
      .on("get", this.getCurrentTemperature.bind(this));

    this.service
      .getCharacteristic(Characteristic.HeatingThresholdTemperature)
      .on("set", this.setHeatingThresholdTemperature.bind(this));

    this.service
      .getCharacteristic(Characteristic.TargetHeaterCoolerState)
      .on("get", this.getTargetHeaterCoolerState.bind(this));

    this.service
      .getCharacteristic(Characteristic.Name)
      .on("get", this.getName.bind(this));

    // ---- Accessory Information ----
    this.informationService = new Service.AccessoryInformation();
    this.informationService
      .setCharacteristic(Characteristic.Manufacturer, this.manufacturer)
      .setCharacteristic(Characteristic.Model, this.model)
      .setCharacteristic(Characteristic.SerialNumber, this.device_id);

    // ---- Timer (created now, started after login) ----
    this.pullTimer = new PullTimer(
      this.log,
      this.pullInterval,
      this.refreshTesyHeaterStatus.bind(this),
      () => {}
    );

    // ---- Kick off login, then start polling ----
    if (this.username && this.password) {
      this.authenticate()
        .then(() => {
          this.pullTimer.start();
          // Do an immediate first refresh
          this.refreshTesyHeaterStatus();
        })
        .catch((e) => {
          this.log.error("Initial authentication failed. Will still start timer and retry on next ticks.");
          this.pullTimer.start();
        });
    } else {
      this.log.warn("Username/password not provided; device will remain INACTIVE.");
      this.pullTimer.start();
    }

    this.log.info(this.name);
  }

  // ---- HomeKit identity ----
  identify(callback) {
    this.log.info("Hi, I'm", this.name);
    callback();
  }

  getName(callback) {
    callback(null, this.name);
  }

  getTargetHeaterCoolerState(callback) {
    callback(null, Characteristic.TargetHeaterCoolerState.HEAT);
  }

  // ---- Helpers to map Tesy fields ----
  getTesyHeaterActiveState(state) {
    if (!state) return Characteristic.Active.INACTIVE;
    return state.toLowerCase() === "on"
      ? Characteristic.Active.ACTIVE
      : Characteristic.Active.INACTIVE;
  }

  getTesyHeaterCurrentHeaterCoolerState(state) {
    // READY = IDLE; otherwise assume heating when active
    if (!state) return Characteristic.CurrentHeaterCoolerState.INACTIVE;
    return state.toUpperCase() === "READY"
      ? Characteristic.CurrentHeaterCoolerState.IDLE
      : Characteristic.CurrentHeaterCoolerState.HEATING;
  }

  // ---- API calls (axios) ----
  async authenticate() {
    try {
      const { data } = await axios.post(
        "https://ad.mytesy.com/rest/old-app-login",
        {
          email: this.username,
          password: this.password,
          userID: this.userid,
          userEmail: this.username,
          userPass: this.password,
          lang: "en",
        },
        { headers: { "content-type": "application/json" }, timeout: 10000 }
      );

      // Expected fields from Tesy "old-app" login:
      this.session = data.acc_session || data.PHPSESSID || "";
      this.alt = data.acc_alt || data.ALT || "";

      if (!this.session || !this.alt) {
        throw new Error("Missing session/alt in login response");
      }

      this.log.info("Authenticated to Tesy (old-app).");
    } catch (error) {
      const msg = error?.response?.data || error.message;
      this.log.error("Authentication failed:", msg);
      throw error;
    }
  }

  async refreshTesyHeaterStatus() {
    this.log.debug("Executing refreshTesyHeaterStatus");

    // Avoid overlapping polls
    this.pullTimer.stop();

    try {
      if (!this.session || !this.alt) {
        this.log.warn("No session/alt yet; re-authenticating...");
        await this.authenticate();
      }

      const { data } = await axios.post(
        "https://ad.mytesy.com/rest/old-app-devices",
        {
          ALT: this.alt,
          CURRENT_SESSION: null,
          PHPSESSID: this.session,
          last_login_username: this.username,
          userID: this.userid,
          userEmail: this.username,
          userPass: this.password,
          lang: "en",
        },
        { headers: { "content-type": "application/json" }, timeout: 10000 }
      );

      if (!data?.device || Object.keys(data.device).length === 0) {
        throw new Error("No devices in response");
      }

      const firstKey = Object.keys(data.device)[0];
      const status = data.device[firstKey]?.DeviceStatus;

      if (!status) throw new Error("DeviceStatus missing");

      this.updateDeviceStatus(status);
    } catch (error) {
      const msg = error?.response?.data || error.message;
      this.log.error("Failed to refresh heater status:", msg);

      // Set to INACTIVE on failure to avoid stale "active" UI
      try {
        this.service
          .getCharacteristic(Characteristic.Active)
          .updateValue(Characteristic.Active.INACTIVE);
      } catch (_) {}
    } finally {
      this.pullTimer.start();
    }
  }

  updateDeviceStatus(status) {
    // Current temperature: status.gradus
    const newCurrentTemperature = parseFloat(status.gradus);
    const oldCurrentTemperature =
      this.service.getCharacteristic(Characteristic.CurrentTemperature).value;

    if (
      Number.isFinite(newCurrentTemperature) &&
      newCurrentTemperature !== oldCurrentTemperature &&
      newCurrentTemperature >= this.minTemp &&
      newCurrentTemperature <= this.maxTemp
    ) {
      this.service
        .getCharacteristic(Characteristic.CurrentTemperature)
        .updateValue(newCurrentTemperature);
      this.log.info(
        "Changing CurrentTemperature from %s to %s",
        oldCurrentTemperature,
        newCurrentTemperature
      );
    }

    // Target temp: status.ref_gradus
    const newHeatingThresholdTemperature = parseFloat(status.ref_gradus);
    const oldHeatingThresholdTemperature =
      this.service.getCharacteristic(Characteristic.HeatingThresholdTemperature).value;

    if (
      Number.isFinite(newHeatingThresholdTemperature) &&
      newHeatingThresholdTemperature !== oldHeatingThresholdTemperature &&
      newHeatingThresholdTemperature >= this.minTemp &&
      newHeatingThresholdTemperature <= this.maxTemp
    ) {
      this.service
        .getCharacteristic(Characteristic.HeatingThresholdTemperature)
        .updateValue(newHeatingThresholdTemperature);
      this.log.info(
        "Changing HeatingThresholdTemperature from %s to %s",
        oldHeatingThresholdTemperature,
        newHeatingThresholdTemperature
      );
    }

    // Power state: status.power_sw => "on" / "off"
    const newHeaterActiveStatus = this.getTesyHeaterActiveState(status.power_sw);
    const oldHeaterActiveStatus =
      this.service.getCharacteristic(Characteristic.Active).value;

    if (
      newHeaterActiveStatus !== undefined &&
      newHeaterActiveStatus !== oldHeaterActiveStatus
    ) {
      this.service
        .getCharacteristic(Characteristic.Active)
        .updateValue(newHeaterActiveStatus);
      this.log.info(
        "Changing ActiveStatus from %s to %s",
        oldHeaterActiveStatus,
        newHeaterActiveStatus
      );
    }

    // Heating state: status.heater_state => READY / HEATING
    const newCurrentHeaterCoolerState = this.getTesyHeaterCurrentHeaterCoolerState(
      status.heater_state
    );
    const oldCurrentHeaterCoolerState =
      this.service.getCharacteristic(Characteristic.CurrentHeaterCoolerState).value;

    if (newCurrentHeaterCoolerState !== oldCurrentHeaterCoolerState) {
      this.service
        .getCharacteristic(Characteristic.CurrentHeaterCoolerState)
        .updateValue(newCurrentHeaterCoolerState);
      this.log.info(
        "Changing CurrentHeaterCoolerState from %s to %s",
        oldCurrentHeaterCoolerState,
        newCurrentHeaterCoolerState
      );
    }
  }

  // ---- HomeKit characteristic handlers ----
  getActive(callback) {
    // Return current cached value immediately
    try {
      const v = this.service.getCharacteristic(Characteristic.Active).value;
      callback(null, v);
    } catch (e) {
      callback(e);
    }

    // Also trigger a background refresh (not blocking callback)
    this.refreshTesyHeaterStatus().catch(() => {});
  }

  async setActive(value, callback) {
    this.log.info("[+] Changing Active status to value:", value);

    this.pullTimer.stop();
    const newValue = value === 0 ? "off" : "on";

    try {
      if (!this.session || !this.alt) {
        await this.authenticate();
      }

      await axios.post(
        "https://ad.mytesy.com/rest/old-app-set-device-status",
        {
          ALT: this.alt,
          CURRENT_SESSION: null,
          PHPSESSID: this.session,
          last_login_username: this.username,
          id: this.device_id,
          apiVersion: "apiv1",
          command: "power_sw",
          value: newValue,
          userID: this.userid,
          userEmail: this.username,
          userPass: this.password,
          lang: "en",
        },
        { headers: { "content-type": "application/json" }, timeout: 10000 }
      );

      // Optimistically update
      this.service
        .getCharacteristic(Characteristic.Active)
        .updateValue(value);

      callback(null, value);
    } catch (error) {
      const msg = error?.response?.data || error.message;
      this.log.error("Failed to set Active:", msg);
      callback(error);
    } finally {
      this.pullTimer.start();
    }
  }

  getCurrentTemperature(callback) {
    // Return cached value
    try {
      const v =
        this.service.getCharacteristic(Characteristic.CurrentTemperature).value;
      callback(null, v);
    } catch (e) {
      callback(e);
    }

    // Kick a refresh to keep it warm
    this.refreshTesyHeaterStatus().catch(() => {});
  }

  async setHeatingThresholdTemperature(value, callback) {
    let v = value;
    if (v < this.minTemp) v = this.minTemp;
    if (v > this.maxTemp) v = this.maxTemp;
    this.log.info("[+] Changing HeatingThresholdTemperature to:", v);

    this.pullTimer.stop();

    try {
      if (!this.session || !this.alt) {
        await this.authenticate();
      }

      await axios.post(
        "https://ad.mytesy.com/rest/old-app-set-device-status",
        {
          ALT: this.alt,
          CURRENT_SESSION: null,
          PHPSESSID: this.session,
          last_login_username: this.username,
          id: this.device_id,
          apiVersion: "apiv1",
          command: "tmpT",
          value: v,
          userID: this.userid,
          userEmail: this.username,
          userPass: this.password,
          lang: "en",
        },
        { headers: { "content-type": "application/json" }, timeout: 10000 }
      );

      // Optimistically update
      this.service
        .getCharacteristic(Characteristic.HeatingThresholdTemperature)
        .updateValue(v);

      callback(null, v);
    } catch (error) {
      const msg = error?.response?.data || error.message;
      this.log.error("Failed to set target temperature:", msg);
      callback(error);
    } finally {
      this.pullTimer.start();
    }
  }

  // ---- Services ----
  getServices() {
    // Trigger an initial refresh (non-blocking)
    this.refreshTesyHeaterStatus().catch(() => {});
    return [this.informationService, this.service];
  }
}
