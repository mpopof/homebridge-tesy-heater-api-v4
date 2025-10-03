# homebridge-tesy-heater-api-v4

Homebridge plugin for Tesy smart heaters using the `ad.mytesy.com/rest/old-app-*` endpoints.
Uses axios with a cookie jar to capture `PHPSESSID` if the API does not return `acc_session`/`acc_alt` in JSON.

## Install (local dev)

```bash
npm install
sudo npm link
# then configure in Homebridge UI
```

## Config fields

- **name**: display name in HomeKit
- **device_id**: device identifier as used by Tesy API
- **username / password**: Tesy account
- **userid**: (optional) some accounts require it
- **pullInterval**: status refresh period in ms (default 10000)
- **minTemp / maxTemp**: bounds for target temperature

## Notes

- Requires Node 16+ and Homebridge 1.6+
- Endpoints used:
  - `https://ad.mytesy.com/rest/old-app-login`
  - `https://ad.mytesy.com/rest/old-app-devices`
  - `https://ad.mytesy.com/rest/old-app-set-device-status`
