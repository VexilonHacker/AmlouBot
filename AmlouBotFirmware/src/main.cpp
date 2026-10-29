#include <math.h>  
#include <AsyncTCP.h>
#include <WiFi.h>
#include <Wire.h>
#include <Adafruit_NeoPixel.h>
#include <Adafruit_AHTX0.h>
#include <Adafruit_BMP280.h>
#include <Adafruit_INA219.h>
#include <VL53L1X.h>
#include <Adafruit_BNO055.h>
#include <Adafruit_LTR390.h>
#include <TinyGPSPlus.h>

#define AP_SSID "AmlouBot"
#define AP_PASS "Worisami1337"
#define PORT 19820
#define NEOPIXEL_PIN 48
#define NEOPIXEL_COUNT 1
#define I2C_SDA 8
#define I2C_SCL 9
#define BMP280_ADDRESS 0x77 // idk but BMP280 didnt work. maybe problem from sensor
#define AHTX20_ADDRESS 0x38
#define VL53L1X_ADDRESS 0x29
#define INA219_ADDRESS 0x40
#define LTR390_ADDRESS 0x53
#define BNO055_ADDRESS 0x28
#define SEA_LEVEL_PRESSURE_HPA_NAJING 1017.0f 

IPAddress local_IP(192, 168, 1, 1);
IPAddress gateway(192, 168, 1, 1);
IPAddress subnet(255, 255, 255, 0);
AsyncServer tcpServer(PORT);


Adafruit_NeoPixel pixels(NEOPIXEL_COUNT, NEOPIXEL_PIN, NEO_GRB + NEO_KHZ800);
Adafruit_LTR390 ltr;
Adafruit_AHTX0 aht;
Adafruit_BMP280 bmp;
VL53L1X sensor;
Adafruit_INA219 ina;
TinyGPSPlus    gps;
HardwareSerial GPS(1);

AsyncClient* gClient = nullptr;

struct powerData {
  float sv = 0;
  float bv = 0;
  float c  = 0;
  float pw = 0;
  float lv = 0;
};

struct gpsData {
  bool   valid  = false;
  double lat    = NAN;
  double lon    = NAN;
  float  alt    = NAN;
  float  hdop   = NAN;
  float  speed  = NAN;
  float  course = NAN;
  int    sats   = 0;
};

struct lightData {
  uint32_t als = 0;
  float    lux = 0;
  uint32_t uvs = 0;
  float    uvi = 0;
  bool     dark = false;
};


lightData ld;
gpsData gd;
powerData pd;

int GPS_RX = 18;
int GPS_TX = 17;


int FRONT_LEDS_PIN_1 = 21; 
int FRONT_LEDS_PIN_2 = 40; 

int IN1_H1 = 7, IN2_H1 = 6, IN3_H1 = 5, IN4_H1 = 4;
int IN1_H2 = 13, IN2_H2 = 12, IN3_H2 = 11, IN4_H2 = 10;

int SERVO_FREQ = 50;
int SERVO_MIN_US = 400;
int SERVO_MAX_US = 2600;
int SERVO_RESOLUTION = 14;
int SERVO_PERIOD_US = 20000;
int SERVO_MAX_DUTY = (1UL << SERVO_RESOLUTION) - 1;


int PIN_BASE = 1; // Base 
int PIN_SV1 = 2;  // Shoulder
int PIN_SGP = 41; // Grip
int PIN_SV2 = 42; // Wrist

int servoPins[4] = {PIN_BASE, PIN_SV1, PIN_SGP, PIN_SV2};
int h_motors[8] = {IN1_H1, IN2_H1, IN3_H1, IN4_H1, IN1_H2, IN2_H2, IN3_H2, IN4_H2};

int lastCMDTime = 0;
int CMD_TIMEOUT = 1500;
int  lastTelemetry = 0;
int TELEMETRY_MS = 1000;

// i added vlx so i think tomorrow i'll add scanning 180 deg map env ok 
bool  scanActive = false;
int scanStep   = 2;
int scanAngle  = 0;
int scanIndex  = 0;
int scanTotal  = 0;
int scanNextMs = 0;

int  SCAN_SETTLE_MS = 150;
int SCAN_STEP_MS = 85;


bool clientConnected = false; 
bool ahtOK = false;
bool bmpOK = false;
bool vlxOK = false;
bool inaOK = false;
bool  ltrOK = false;


float  LTR_GAIN_FACTOR  = 18.0f;
float  LTR_INT_TIME_MS  = 100.0f;
float  DARK_LUX_THRESHOLD = 5.0f;
bool  ltrReadALS = true; 
bool autoLightEnabled = false;
bool autoLightApplied = false;


void setRGB(uint8_t r, uint8_t g, uint8_t b) {
  pixels.setPixelColor(0, pixels.Color(r, g, b));
  pixels.show();
}

void setMotor( int m11, int m12, int m13, int m14, int m21, int m22, int m23, int m24) {
  digitalWrite(IN1_H1, m11); digitalWrite(IN2_H1, m12);
  digitalWrite(IN3_H1, m13); digitalWrite(IN4_H1, m14);
  
  digitalWrite(IN1_H2, m21); digitalWrite(IN2_H2, m22);
  digitalWrite(IN3_H2, m23); digitalWrite(IN4_H2, m24);
}

void Forward(){setMotor(0,1,0,1, 1,0,1,0); Serial.println("Forward"); setRGB(0, 255, 0);}
void ForwardLeft(){setMotor(0,1,0,0, 1,0,0,0); Serial.println("ForwardRight"); setRGB(255, 255, 0);}
void ForwardRight(){setMotor(0,0,0,1, 0,0,1,0); Serial.println("ForwardLeft"); setRGB(0, 255, 255);}

void Backward(){setMotor(1,0,1,0, 0,1,0,1); Serial.println("BACK"); setRGB(255, 0, 0);}
void BackwardRight(){setMotor(1,0,0,0, 0,1,0,0); Serial.println("BackwardRight"); setRGB(255, 80, 0);}
void BackwardLeft(){setMotor(0,0,1,0, 0,0,0,1); Serial.println("BackwardLeft"); setRGB(180, 0, 255);}


void Right(){setMotor(1,0,0,1, 0,1,1,0); Serial.println("Right"); setRGB(255, 0, 180);}
void Left(){setMotor(0,1,1,0, 1,0,0,1); Serial.println("Left"); setRGB(0, 255, 150); }

void RotateRight(){setMotor(1,0,1,0, 1,0,1,0); Serial.println("RotateRight"); setRGB(255, 20, 100);}
void RotateLeft(){setMotor(0,1,0,1, 0,1,0,1); Serial.println("RotateLeft"); setRGB(100, 0, 255);}

void Stop(){setMotor(0,0,0,0,0,0,0,0); setRGB(255, 255, 255);}


static uint32_t angle2duty(int angle) {
    angle = constrain(angle, 0, 180);
    const uint32_t pulseUs = map(angle, 0, 180, SERVO_MIN_US, SERVO_MAX_US);
    return (pulseUs * SERVO_MAX_DUTY) / SERVO_PERIOD_US;
}

static void servoWrite(int pin, int angle) {
    angle = constrain(angle, 0, 180);

    if (!ledcWrite(pin, angle2duty(angle))) {
        Serial.printf("ERROR: LEDC write failed: GPIO=%d, angle=%d\n", pin, angle);
    }
}


void setFrontLights(bool f1, bool f2) {
  digitalWrite(FRONT_LEDS_PIN_1, f1); digitalWrite(FRONT_LEDS_PIN_2, f2);
}


void processCommand(String cmd) {
  lastCMDTime = millis();
  cmd.trim();
  if(cmd=="F") Forward();
  if(cmd=="B") Backward();
  if(cmd=="R") Right();
  if(cmd=="L") Left();

  if(cmd=="FR") ForwardRight();
  if(cmd=="FL") ForwardLeft();
  if(cmd=="BR") BackwardRight();
  if(cmd=="BL") BackwardLeft();

  if(cmd=="RR") RotateRight();
  if(cmd=="RL") RotateLeft();

  if(cmd=="STOP") Stop();

  if (cmd == "AUTO,ON") {
    autoLightEnabled = true;
    if (ltrOK) {
      setFrontLights(ld.dark, ld.dark);
      autoLightApplied = ld.dark;
    }
    Serial.println("AUTO LIGHT ON");
    return;
  }

  if (cmd == "AUTO,OFF") {
    autoLightEnabled = false;
    Serial.println("AUTO LIGHT OFF");
    return;
  }

  if (cmd.startsWith("LED")) {

    if (autoLightEnabled && (cmd == "LED,ON" || cmd == "LED,OFF")) {
      autoLightEnabled = false;
      Serial.println("AUTO disabled by manual LED command");
    }


    if (cmd == "LED,ON")   setFrontLights(1,1);
    if (cmd == "LED,OFF")  setFrontLights(0,0);
    if (cmd == "LED,BLINK") {
      setFrontLights(1,1); delay(200);
      setFrontLights(0,0); delay(200);
    }

    if (cmd == "LED,ALT") {
      setFrontLights(1,0); delay(200);
      setFrontLights(0,1); delay(200);
      setFrontLights(1,0); delay(200);
      setFrontLights(0,1); delay(200);
      setFrontLights(1,0); delay(200);
      setFrontLights(0,1); delay(200);
      setFrontLights(0, 0);
    }

    if (autoLightEnabled && (cmd == "LED,BLINK" || cmd == "LED,ALT")) {
      bool wantLights = ld.dark;
      setFrontLights(wantLights, wantLights);
      autoLightApplied = wantLights;
      Serial.printf("AUTO restored after animation (lux=%.1f)\n", ld.lux);
    }
    return;
  }

  if(cmd.startsWith("SV")) {
    // for future me, data should be sent like this: SV105,180,110,60
    cmd.remove(0,2);
    int a,b,c,d;
    sscanf(cmd.c_str(), "%d,%d,%d,%d", &a,&b,&c,&d);
    setRGB(180, 255, 0);
    servoWrite(PIN_BASE,a);
    servoWrite(PIN_SV1,b);
    servoWrite(PIN_SGP,c);
    servoWrite(PIN_SV2,d);

    Serial.printf("base=%d, sv1=%d, sv2=%d, gp=%d\n", a, b, d, c);
  }

  if (cmd == "SCAN" || cmd.startsWith("SCAN,")) {
    if (cmd == "SCAN,STOP") {
      if (scanActive) {
        scanActive = false;
        Serial.println("scan aborted");
      }
      return;
    }

    int s = 2;
    if (cmd.length() > 5) {
      s = cmd.substring(5).toInt();
      s = constrain(s, 1, 45);
    }

    scanStep   = s;
    scanAngle  = 0;
    scanIndex  = 0;
    scanTotal  = 180 / scanStep + 1;
    scanActive = true;

    servoWrite(PIN_BASE, 0);
    scanNextMs = millis() + SCAN_SETTLE_MS;

    Serial.printf("scan start step=%d total=%d\n", scanStep, scanTotal);
    return;
  }

  if (scanActive) {
    scanActive = false;
    Serial.println("scan aborted by command");
  }

}

// tcp server 
String rxBuffer;
void clientConnection(void *arg, AsyncClient *client){
    clientConnected = true;
    gClient = client;
    Serial.printf("client connected %s:%d  |:> \n", client->remoteIP().toString(), client->remotePort());
    setRGB(255, 150, 0);

    client->onData([](void *arg, AsyncClient *client, void *data, size_t len) {
        for(size_t i = 0; i < len; i++) {
            char c = ((char*)data)[i];
            if (c == '\n') {
              rxBuffer.trim();

              if(rxBuffer.length() > 0) {
                Serial.printf("cmd=%s\n", rxBuffer.c_str());
                processCommand(rxBuffer);
                if(client->connected()) client->write("OK\n");
              }
              rxBuffer = "";

            } else if(c != '\r') {
              rxBuffer += c;
              if(rxBuffer.length() > 128) {
                rxBuffer = "";
                if(client->connected()) client->write("ERR\n");
              }
            }
        }
    } ,nullptr);

    client->onDisconnect([](void *arg, AsyncClient *client) {
      Serial.println("TCP client disconnected");
      clientConnected = false;
      rxBuffer = "";
      if (scanActive) {
        scanActive = false;
        Serial.println("scan aborted (disconnect)");
      }

      if (gClient == client) gClient = nullptr;

      Stop();
      setRGB(0, 0, 255);


    }, nullptr);

}

void sendTelemetry(AsyncClient* c) {
  if (!c || !c->connected()) return;

  float t = NAN, h = NAN, dp = NAN, p = NAN, alt = NAN, dist = NAN;
  if (ahtOK) {
    sensors_event_t he, te;
    aht.getEvent(&he, &te);
    t = te.temperature;
    h = he.relative_humidity;
    if (h > 0.0f && h <= 100.0f) {
      const float a = 17.62f, b = 243.12f;
      float g = logf(h / 100.0f) + (a * t) / (b + t);
      dp = (b * g) / (a - g);
    }
  }
  if (bmpOK) {
    p   = bmp.readPressure() / 100.0f;
    alt = bmp.readAltitude(SEA_LEVEL_PRESSURE_HPA_NAJING);
  }

  if (vlxOK) {
    static float lastDist = NAN;
    if (sensor.dataReady()) {
      uint16_t mm = sensor.read(false);
      bool timedOut = sensor.timeoutOccurred();
      bool valid = !timedOut
                && sensor.ranging_data.range_status == VL53L1X::RangeValid
                && mm > 0;
      if (valid) lastDist = (float)mm;
    }
    dist = lastDist;
  }

  char buf[450];

  int n = snprintf(buf, sizeof(buf), "{\"ms\":%lu,\"t\":%.2f,\"h\":%.2f,\"dp\":%.2f,\"p\":%.2f,\"alt\":%.2f,\"dist\":%.2f,\"bv\":%.2f,\"sv\":%.2f,\"lv\":%.2f,\"c\":%.2f,\"pw\":%.2f,\"lat\":%.6f,\"lon\":%.6f,\"galt\":%.2f,\"hdop\":%.2f,\"spd\":%.2f,\"crs\":%.2f,\"sats\":%d,\"gfix\":%d,\"lux\":%.2f,\"uvi\":%.2f,\"als\":%lu,\"uvs\":%lu,\"dark\":%d,\"auto\":%d}\n", millis(), t, h, dp, p, alt, dist, pd.bv, pd.sv, pd.lv, pd.c, pd.pw, gd.lat, gd.lon, gd.alt, gd.hdop, gd.speed, gd.course, gd.sats, gd.valid ? 1 : 0, ld.lux, ld.uvi, (unsigned long)ld.als, (unsigned long)ld.uvs, ld.dark ? 1 : 0, autoLightEnabled ? 1 : 0);
  // bruh it became tooooooo long :) but sweet

    // Serial.printf("BV=%.2f V | SV=%.2f mV | LV=%.2f V | C=%.2f mA | PW=%.2f mW\n", pd.sv, pd.bv, pd.lv, pd.c, pd.pw);
  c->add(buf, n);
  c->send();
}

void testServos(){

  int default_vars[4] = {105, 180, 110, 60};
  for (int servo = 0 ; servo < 4; servo++) {
    Serial.printf("Servo number: %d\n", servo);

    for (int  i = 0 ; i < 180 ; i++ ) {
      servoWrite(servoPins[servo], i);
      delay(10);
    }

    servoWrite(servoPins[servo], default_vars[servo]);
  }
}

static inline float alsToLux(uint32_t als) {
  return (0.6f * (float)als) / (LTR_GAIN_FACTOR * (LTR_INT_TIME_MS / 100.0f));
}

static inline float uvsToUVI(uint32_t uvs) {
  float countsPerUVI = 2300.0f * (18.0f / LTR_GAIN_FACTOR) * (400.0f / LTR_INT_TIME_MS);
  return (float)uvs / countsPerUVI;
}

void ltr_data(bool debug) {
  if (!ltrOK) return;

  if (ltrReadALS) {
    ltr.setMode(LTR390_MODE_ALS);
    delay(150);
    if (ltr.newDataAvailable()) {
      ld.als  = ltr.readALS();
      ld.lux  = alsToLux(ld.als);
      ld.dark = ld.lux < DARK_LUX_THRESHOLD;
    }
  } else {
    ltr.setMode(LTR390_MODE_UVS);
    delay(150);
    if (ltr.newDataAvailable()) {
      ld.uvs = ltr.readUVS();
      ld.uvi = uvsToUVI(ld.uvs);
    }
  }
  ltrReadALS = !ltrReadALS;

  if (debug) {
    Serial.printf("ALS=%lu LUX=%.2f UVS=%lu UVI=%.2f %s\n", (unsigned long)ld.als, ld.lux, (unsigned long)ld.uvs, ld.uvi, ld.dark ? "DARK" : "LIGHT");
  }
}

void setup() {
  Serial.begin(115200);
  delay(500);
  // pinMode(FRONT_LEDS_PIN_1, OUTPUT); digitalWrite(FRONT_LEDS_PIN_1, 0);
  // pinMode(FRONT_LEDS_PIN_2, OUTPUT); digitalWrite(FRONT_LEDS_PIN_2, 0);
  // delay(3000);
  // Serial.println("testing leds");
  // while (1) {
  //   digitalWrite(FRONT_LEDS_PIN_1, 1);
  //   digitalWrite(FRONT_LEDS_PIN_2, 1);
  //   Serial.println(1);
  //   delay(250);
  //
  //   digitalWrite(FRONT_LEDS_PIN_1, 1);
  //   digitalWrite(FRONT_LEDS_PIN_2, 0);
  //   Serial.println(2);
  //   delay(250);
  //
  //   digitalWrite(FRONT_LEDS_PIN_1, 0);
  //   digitalWrite(FRONT_LEDS_PIN_2, 1);
  //   Serial.println(3);
  //   delay(250);
  //
  //   digitalWrite(FRONT_LEDS_PIN_1, 0);
  //   digitalWrite(FRONT_LEDS_PIN_2, 0);
  //   Serial.println(4);
  //   delay(250);
  // }
  
  GPS.begin(9600, SERIAL_8N1, GPS_RX, GPS_TX);
  Serial.println("GPS started");


  Wire.begin(I2C_SDA, I2C_SCL);
  pixels.begin();
  sensor.setTimeout(500);

  ahtOK = aht.begin(&Wire);
  bmpOK = bmp.begin(BMP280_ADDRESS);
  vlxOK = sensor.init();
  inaOK = ina.begin();
  ltrOK = ltr.begin(&Wire);

  pixels.setBrightness(255);
  setRGB(255, 255, 255);
  delay(1000);
  
  if (ahtOK) {Serial.println("AHT20 200"); } else { Serial.println("AHT20 404");}
  if (inaOK) {Serial.println("INA219 200"); } else { Serial.println("INA219 404");}

  if (ltrOK) {
    Serial.println("LTR390 200"); 
    ltr.setGain(LTR390_GAIN_18);
    ltr.setResolution(LTR390_RESOLUTION_18BIT);
    ltr.setMode(LTR390_MODE_ALS);
    delay(150);
  }
  else { 
    Serial.println("LTR390 404"); 
  }

  if (bmpOK) {
    Serial.println("BMP280 200");
    bmp.setSampling(
                    Adafruit_BMP280::MODE_NORMAL, 
                    Adafruit_BMP280::SAMPLING_X2, 
                    Adafruit_BMP280::SAMPLING_X16, 
                    Adafruit_BMP280::FILTER_X16, 
                    Adafruit_BMP280::STANDBY_MS_500
    );
  } else {
    Serial.println("BMP280 400");
  }
  if (vlxOK) {
    Serial.println("VL53L1X 200");
    sensor.setDistanceMode(VL53L1X::Long);
    sensor.setMeasurementTimingBudget(50000);
    sensor.startContinuous(50);
  } else { 
    Serial.println("VL53L1X 404");
  }
  
  if (!ahtOK && !bmpOK && !vlxOK && !inaOK && !ltrOK) {
    Serial.println("no sensors initialized >:{ ");
  }


  WiFi.mode(WIFI_AP);
  if(!WiFi.softAPConfig(local_IP, gateway, subnet)) Serial.println("ap failed");
  if(WiFi.softAP(AP_SSID,AP_PASS)) Serial.println("AP Started");

  tcpServer.onClient(clientConnection, nullptr);
  tcpServer.begin();


  for (int p = 0; p < sizeof(h_motors)/sizeof(h_motors[0]); p++) {
    pinMode(h_motors[p], OUTPUT);
    digitalWrite(h_motors[p], 0);
  }
  
   
  for (int p = 0 ; p < sizeof(servoPins)/sizeof(servoPins[0]); p++){
    if (!ledcAttach(servoPins[p], SERVO_FREQ, SERVO_RESOLUTION)) {
        Serial.printf("[-] ERROR: Could not attach PWM to GPIO_%d\n", servoPins[p]);
    } else {
        Serial.printf("[+] PWM connected to GPIO_%d\n", servoPins[p]);

    }
  }
  
  pinMode(FRONT_LEDS_PIN_1, OUTPUT); digitalWrite(FRONT_LEDS_PIN_1, 0);
  pinMode(FRONT_LEDS_PIN_2, OUTPUT); digitalWrite(FRONT_LEDS_PIN_2, 0);


  servoWrite(PIN_BASE, 105);
  servoWrite(PIN_SV1, 180);
  servoWrite(PIN_SGP, 110);
  servoWrite(PIN_SV2, 60);
 
  Serial.printf("RoboHand is ready ->|^_^|-> connect through %s:%d\n", WiFi.softAPIP().toString(), PORT);

  
  for (int t = 0 ; t < 3 ; t++) {
    setFrontLights(1, 1);
    delay(500);
    setFrontLights(0, 0);
    delay(500);
  }
  // testServos();
  // while (1) {
  // for (int  i = 0 ; i < 180 ; i++ ) {
  //   servoWrite(PIN_SV1, i);
  //   delay(10);
  // }
  // }
}

void gps_data(bool debug) {
  gd.valid = gps.location.isValid();
  if (gd.valid) {
    gd.lat    = gps.location.lat();
    gd.lon    = gps.location.lng();
    gd.alt    = gps.altitude.meters();
    gd.hdop   = gps.hdop.hdop();
    gd.speed  = gps.speed.kmph();
    gd.course = gps.course.deg();
  } else {
    gd.lat = gd.lon = gd.alt = gd.hdop = gd.speed = gd.course = NAN;
  }
  gd.sats = gps.satellites.value();

  if (debug) {
    if (gd.valid) {
      Serial.printf("GPS Lat=%.6f Lon=%.6f alt=%.1fm sats=%d hdop=%.1f\n",
                    gd.lat, gd.lon, gd.alt, gd.sats, gd.hdop);
    } else {
      Serial.printf("GPS no fix  sats=%d\n", gd.sats);
    }
  }
}

void ina_data(bool debug){
  pd.sv = ina.getShuntVoltage_mV();
  pd.bv = ina.getBusVoltage_V();
  pd.c = ina.getCurrent_mA();
  pd.pw = ina.getPower_mW();
  pd.lv = pd.bv + (pd.sv / 1000);
  if (debug) {
    Serial.printf("BV=%.2f V | SV=%.2f mV | LV=%.2f V | C=%.2f mA | PW=%.2f mW\n", pd.sv, pd.bv, pd.lv, pd.c, pd.pw);
  }

}
void loop() {
 
  while (GPS.available()) gps.encode(GPS.read());    
  if (scanActive && millis() >= scanNextMs) {
    float d = NAN, sig = 0;
    int st = -1;

    if (vlxOK) {
      const int MAX_ATTEMPTS = 2;
      const unsigned long RETRY_WAIT_MS = 70;

      for (int attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        unsigned long t0 = millis();
        while (!sensor.dataReady()) {
          if (millis() - t0 > 100) break;
          delay(2);
        }

        if (!sensor.dataReady()) {
          st = -1;
          if (attempt == 0) {
            delay(RETRY_WAIT_MS);
            continue;
          }
          break;
        }

        uint16_t mm = sensor.read(false);
        bool timedOut = sensor.timeoutOccurred();
        int raw_st = (int)sensor.ranging_data.range_status;

        if (!timedOut && raw_st == 0 && mm > 0) {
          d   = (float)mm;
          sig = sensor.ranging_data.peak_signal_count_rate_MCPS;
          st  = 0;
          break; 
        }

        st = (raw_st >= 0) ? raw_st : -1;
        if (attempt == 0) delay(RETRY_WAIT_MS);
      }
    }
    if (gClient && gClient->connected()) {
      char buf[160];
      int n = snprintf(buf, sizeof(buf), "{\"scan\":1,\"i\":%d,\"n\":%d,\"ang\":%d,\"d\":%.0f,\"sig\":%.2f,\"st\":%d}\n", scanIndex, scanTotal, scanAngle, d, sig, st);
      gClient->add(buf, n);
      gClient->send();
    }

    Serial.printf("scan %d/%d ang=%d d=%.0f st=%d\n", scanIndex + 1, scanTotal, scanAngle, d, st);

    scanIndex++;
    if (scanIndex >= scanTotal) {
      scanActive = false;
      if (gClient && gClient->connected()) {
        char buf[64];
        int n = snprintf(buf, sizeof(buf), "{\"scan\":1,\"done\":1,\"n\":%d}\n", scanTotal);
        gClient->add(buf, n);
        gClient->send();
      }
      
      servoWrite(PIN_BASE, 105);
      Serial.println("scan done");
    } else {
      
      scanAngle = scanIndex * scanStep;
      servoWrite(PIN_BASE, scanAngle);
      scanNextMs = millis() + SCAN_STEP_MS;
    }
  }

  

  if (gClient && millis() - lastTelemetry >= TELEMETRY_MS) {
    lastTelemetry = millis();
    if (inaOK) ina_data(0);
    if (ltrOK && !scanActive) ltr_data(0);
     gps_data(0);
    sendTelemetry(gClient);
  }

  if (autoLightEnabled && ltrOK && !scanActive) {
    bool wantLights = ld.dark;
    if (wantLights != autoLightApplied) {
      setFrontLights(wantLights, wantLights);
      autoLightApplied = wantLights;
      Serial.printf("AUTO: lights %s (lux=%.1f)\n", wantLights ? "ON" : "OFF", ld.lux);
    }
  }

  static bool wdLatched = false;
  bool wdActive = (millis() - lastCMDTime > CMD_TIMEOUT && clientConnected && !scanActive);

  if (wdActive && !wdLatched) {
    setMotor(0,0,0,0,0,0,0,0);
    setRGB(255, 0, 0);
    wdLatched = true;
  } else if (!wdActive) {
    wdLatched = false;
  }


  delay(10);
}

