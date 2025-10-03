// index.js
const { wrapper } = require("axios-cookiejar-support");
const { CookieJar } = require("tough-cookie");
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

// Shared axios instance with cookie jar and browser-like headers
const jar = new CookieJar();
const api = wrapper(axios.create({
  jar,
  withCredentials: true,
  timeout: 15000,
  headers: {
    "accept": "application/json, text/plain, */*",
    "content-type": "application/json",
    "origin": "https://v4.mytesy.com",
    "referer": "https://v4.mytesy.com/",
    "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "dnt": "1"
  },
  validateStatus: (s) => s >= 200 && s < 400
}));

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

    // Default initial states
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

    // ---- Timer ----
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
          this.refreshTesyHeaterStatus();
        })
        .catch(() => {
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
    if (!state) return Characteristic.CurrentHeaterCoolerState.INACTIVE;
    return state.toUpperCase() === "READY"
      ? Characteristic.CurrentHeaterCoolerState.IDLE
      : Characteristic.CurrentHeaterCoolerState.HEATING;
  }

  // ---- API calls (axios + cookies) ----
  async authenticate() {
    try {
      const resp = await api.post(
        "https://ad.mytesy.com/rest/old-app-login",
        {
          email: this.username,
          password: this.password,
          userID: this.userid || "",
          userEmail: this.username,
          userPass: this.password,
          lang: "en",
        }
      );

      const data = resp.data || {};
      this.log.debug("Login response keys:", Object.keys(data));

      // Preferred (old behavior)
      this.session = data.acc_session || data.PHPSESSID || "";
      this.alt     = data.acc_alt || data.ALT || "";

      // Fallback to cookies for PHPSESSID
      if (!this.session) {
        const cookies = await jar.getCookies("https://ad.mytesy.com/");
        const phpsess = cookies.find(c => c.key.toUpperCase() === "PHPSESSID");
        if (phpsess) this.session = phpsess.value;
      }

      if (!this.session) {
        throw new Error("Missing session (neither JSON nor cookie contained PHPSESSID)");
      }

      if (!this.alt) {
        this.log.warn("ALT not present in login response; will try to infer later.");
      }

      this.log.info("Authenticated (cookies + session captured).");
    } catch (error) {
      const msg = error?.response?.data || error.message;
      this.log.error("Authentication failed:", msg);
      throw error;
    }
  }

  async refreshTesyHeaterStatus() {
    this.log.debug("Executing refreshTesyHeaterStatus");
    this.pullTimer.stop();

    try {
      if (!this.session) {
        this.log.warn("No session yet; authenticating...");
        await this.authenticate();
      }

      const payload = {
        ALT: this.alt || undefined,
        CURRENT_SESSION: null,
        PHPSESSID: this.session,
        last_login_username: this.username,
        userID: this.userid || "",
        userEmail: this.username,
        userPass: this.password,
        lang: "en"
      };

      const resp = await api.post("https://ad.mytesy.com/rest/old-app-devices", payload);
      const data = resp.data || {};
      this.log.debug("Devices response top-level keys:", Object.keys(data));

      if (!this.alt && (data.acc_alt || data.ALT)) {
        this.alt = data.acc_alt || data.ALT;
        this.log.info("Captured ALT from devices response.");
      }

      if (!data.device || Object.keys(data.device).length === 0) {
        throw new Error("No devices in response");
      }

      const firstKey = Object.keys(data.device)[0];
      const status = data.device[firstKey]?.DeviceStatus;
      if (!status) throw new Error("DeviceStatus missing");

      this.updateDeviceStatus(status);
    } catch (error) {
      const msg = error?.response?.data || error.message;
      this.log.error("Failed to refresh heater status:", msg);
      try {
        this.service.getCharacteristic(Characteristic.Active)
          .updateValue(Characteristic.Active.INACTIVE);
      } catch (_) {}
    } finally {
      this.pullTimer.start();
    }
  }

  updateDeviceStatus(status) {
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
    try {
      const v = this.service.getCharacteristic(Characteristic.Active).value;
      callback(null, v);
    } catch (e) {
      callback(e);
    }
    this.refreshTesyHeaterStatus().catch(() => {});
  }

  async setActive(value, callback) {
    this.log.info("[+] Changing Active status to value:", value);
    this.pullTimer.stop();
    const newValue = value === 0 ? "off" : "on";

    try {
      if (!this.session) await this.authenticate();

      await api.post(
        "https://ad.mytesy.com/rest/old-app-set-device-status",
        {
          ALT: this.alt || undefined,
          CURRENT_SESSION: null,
          PHPSESSID: this.session,
          last_login_username: this.username,
          id: this.device_id,
          apiVersion: "apiv1",
          command: "power_sw",
          value: newValue,
          userID: this.userid || "",
          userEmail: this.username,
          userPass: this.password,
          lang: "en",
        }
      );

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
    try {
      const v =
        this.service.getCharacteristic(Characteristic.CurrentTemperature).value;
      callback(null, v);
    } catch (e) {
      callback(e);
    }
    this.refreshTesyHeaterStatus().catch(() => {});
  }

  async setHeatingThresholdTemperature(value, callback) {
    let v = value;
    if (v < this.minTemp) v = this.minTemp;
    if (v > this.maxTemp) v = this.maxTemp;
    this.log.info("[+] Changing HeatingThresholdTemperature to:", v);

    this.pullTimer.stop();

    try {
      if (!this.session) await this.authenticate();

      await api.post(
        "https://ad.mytesy.com/rest/old-app-set-device-status",
        {
          ALT: this.alt || undefined,
          CURRENT_SESSION: null,
          PHPSESSID: this.session,
          last_login_username: this.username,
          id: this.device_id,
          apiVersion: "apiv1",
          command: "tmpT",
          value: v,
          userID: this.userid || "",
          userEmail: this.username,
          userPass: this.password,
          lang: "en",
        }
      );

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
    this.refreshTesyHeaterStatus().catch(() => {});
    return [this.informationService, this.service];
  }
}
