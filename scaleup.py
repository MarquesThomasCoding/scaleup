import network
import urequests
import utime
from machine import Pin, SPI
from mfrc522 import MFRC522

WIFI_SSID = "WIFI_SSID"
WIFI_PASSWORD = "WIFI_PASSWORD"
API_URL = "https://API_URL:5000/upload"
API_START_URL = "https://API_START_URL:5000/start"
API_TOUCH_URL = "https://API_TOUCH_URL:5000/touch"
API_RESUME_URL = "https://API_RESUME_URL:5000/resume"
API_RESET_URL = "https://API_RESET_URL:5000/reset"

spi = SPI(0, baudrate=1000000, polarity=0, phase=0, sck=Pin(2), mosi=Pin(3), miso=Pin(4))
reader_start = MFRC522(spi, 1, 0)
reader_end = MFRC522(spi, 5, 0)

btn_reset = Pin(15, Pin.IN, Pin.PULL_UP)

wlan = network.WLAN(network.STA_IF)
wlan.active(True)
wlan.connect(WIFI_SSID, WIFI_PASSWORD)
print("Connexion Wi-Fi...")
while not wlan.isconnected():
    utime.sleep(0.5)
print("Connecté ! IP Pico:", wlan.ifconfig()[0])

active_climbers = {}

print("--- SYSTÈME PRÊT ---")

while True:
    if btn_reset.value() == 0:
        if len(active_climbers) > 0:
            print("🛑 BOUTON RESET PRESSÉ ! Phase annulée.")
            active_climbers.clear()
            try:
                res_reset = urequests.post(API_RESET_URL, json={}, timeout=2.0)
                res_reset.close()
                print("✅ Reset synchronisé avec le serveur")
            except Exception as e:
                print(f"⚠️ Erreur push reset : {e}")
        utime.sleep(1.0)
        continue

    stat, tag_type = reader_start.request(reader_start.REQIDL)
    if stat == reader_start.OK:
        stat, uid = reader_start.anticoll()
        if stat == reader_start.OK:
            current_uid = "0x" + "".join([f"{x:02X}" for x in uid])
            if current_uid not in active_climbers:
                active_climbers[current_uid] = utime.ticks_ms()
                print(f"🚀 DÉPART : {current_uid}")
                try:
                    payload = {"uid": current_uid}
                    res_start = urequests.post(API_START_URL, json=payload, timeout=2.0)
                    res_start.close()
                except Exception as e:
                    print(f"⚠️ Erreur départ : {e}")
                utime.sleep(1.5)

    stat, tag_type = reader_end.request(reader_end.REQIDL)
    if stat == reader_end.OK:
        stat, uid = reader_end.anticoll()
        if stat == reader_end.OK:
            end_uid = "0x" + "".join([f"{x:02X}" for x in uid])
            
            if end_uid in active_climbers:
                end_tick = utime.ticks_ms() 
                frozen_time = utime.ticks_diff(end_tick, active_climbers[end_uid]) / 1000
                print(f"Contact {end_uid} ! Maintien de 3s en cours...")
                try:
                    urequests.post(API_TOUCH_URL, json={"uid": end_uid, "temps": frozen_time}, timeout=1.0).close()
                except Exception as e:
                    print(f"⚠️ Erreur touche : {e}")

                top_start_hit = utime.ticks_ms()
                valid = True
                missed_readings = 0
                max_missed = 6 

                while utime.ticks_diff(utime.ticks_ms(), top_start_hit) < 3000:
                    s, t = reader_end.request(reader_end.REQIDL)
                    if s == reader_end.OK:
                        s_col, u = reader_end.anticoll()
                        if s_col == reader_end.OK:
                            u_check = "0x" + "".join([f"{u_byte:02X}" for u_byte in u])
                            if u_check == end_uid:
                                missed_readings = 0
                            else:
                                missed_readings += 1
                        else:
                            missed_readings += 1
                    else:
                        missed_readings += 1
                    
                    if missed_readings > max_missed:
                        print(f"❌ Lâché trop tôt pour {end_uid} !")
                        valid = False
                        try:
                            urequests.post(API_RESUME_URL, json={"uid": end_uid}, timeout=1.0).close()
                        except Exception as e:
                            print(f"⚠️ Erreur : {e}")
                        break
                        
                    utime.sleep(0.1)
                
                if valid:
                    total_seconds = utime.ticks_diff(end_tick, active_climbers[end_uid]) / 1000
                    print(f"🏁 VALIDÉ ! Temps de grimpe : {total_seconds}s")
                    
                    try:
                        payload = {"uid": end_uid, "temps": total_seconds}
                        res = urequests.post(API_URL, json=payload, timeout=3.0)
                        res.close()
                        print("✅ Données envoyées")
                    except Exception as e:
                        print(f"⚠️ Erreur API : {type(e).__name__} - {e}")
                    
                    del active_climbers[end_uid]
                    utime.sleep(2)

    utime.sleep(0.1)