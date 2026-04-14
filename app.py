# ================= IMPORTS =================

import streamlit as st
import cv2
import dlib
import pandas as pd
from scipy.spatial import distance
import plotly.graph_objects as go
import pygame
import threading
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Image
from reportlab.lib.styles import getSampleStyleSheet
from datetime import datetime
import matplotlib.pyplot as plt
import time
import os
import requests
import pywhatkit


# ================= PAGE CONFIG =================

st.set_page_config(layout="wide")

st.title("🚗 Intelligent Driver Safety Monitoring System")


# ================= CONSTANTS =================

EAR_THRESHOLD = 0.25
MAR_THRESHOLD = 0.6


# ================= SESSION STATE =================

defaults = {

    "fatigue_score": 0,
    "alert_counter": 0,
    "yawn_counter": 0,
    "ear_history": [],
    "lat": None,
    "lon": None,
    "city": None,
    "start_time": None

}

for key in defaults:

    if key not in st.session_state:

        st.session_state[key] = defaults[key]


# ================= LOAD MODELS =================

detector = dlib.get_frontal_face_detector()

predictor = dlib.shape_predictor(
    "shape_predictor_68_face_landmarks.dat"
)


# ================= EAR FUNCTION =================

def EAR(eye):

    A = distance.euclidean(eye[1], eye[5])
    B = distance.euclidean(eye[2], eye[4])
    C = distance.euclidean(eye[0], eye[3])

    return (A + B) / (2.0 * C)


# ================= MAR FUNCTION =================

def MAR(mouth):

    A = distance.euclidean(mouth[2], mouth[10])
    B = distance.euclidean(mouth[4], mouth[8])
    C = distance.euclidean(mouth[0], mouth[6])

    return (A + B) / (2.0 * C)


# ================= ALARM =================

def alarm():

    pygame.mixer.init()

    pygame.mixer.music.load("alarm.mp3")

    pygame.mixer.music.play()


# ================= GPS =================

def gps_alert():

    try:

        res = requests.get("http://ip-api.com/json").json()

        st.session_state.lat = res["lat"]

        st.session_state.lon = res["lon"]

        st.session_state.city = res["city"]

        st.success(f"📍 Location detected: {res['city']}")

        st.map(pd.DataFrame({

            "lat":[res["lat"]],
            "lon":[res["lon"]]

        }))

    except:

        st.error("GPS detection failed")


# ================= WHATSAPP ALERT =================

def whatsapp_alert():

    try:

        message = f"""
Driver Drowsiness Alert 🚨

Location:
Latitude: {st.session_state.lat}
Longitude: {st.session_state.lon}

Immediate action required!
"""

        pywhatkit.sendwhatmsg_instantly(

            "+91XXXXXXXXXX",

            message,

            wait_time=10,

            tab_close=True

        )

        st.success("WhatsApp alert sent successfully")

    except:

        st.error("WhatsApp alert failed")


# ================= FATIGUE GAUGE =================

def fatigue_meter(value):

    fig = go.Figure(go.Indicator(

        mode="gauge+number",

        value=value,

        title={'text': "Fatigue Level"},

        gauge={

            'axis': {'range': [0, 100]},

            'steps':[

                {'range':[0,30],'color':'green'},

                {'range':[30,60],'color':'yellow'},

                {'range':[60,100],'color':'red'}

            ]

        }

    ))

    return fig


# ================= REPORT =================

def generate_report():

    file="Driver_Report.pdf"

    graph_img="ear_graph.png"

    styles=getSampleStyleSheet()

    story=[]


    fatigue=st.session_state.fatigue_score

    alerts=st.session_state.alert_counter

    yawns=st.session_state.yawn_counter

    history=st.session_state.ear_history


    if len(history)>0:

        plt.figure(figsize=(6,4))

        plt.plot(history)

        plt.axhline(y=EAR_THRESHOLD,linestyle="--")

        plt.title("EAR Trend")

        plt.savefig(graph_img)

        plt.close()


    duration=0

    if st.session_state.start_time:

        duration=int(time.time()-st.session_state.start_time)


    if fatigue<10:

        status="SAFE"

        recommendation="Driver condition stable"

    elif fatigue<25:

        status="MODERATE RISK"

        recommendation="Take short break soon"

    else:

        status="HIGH RISK"

        recommendation="Stop driving immediately"


    doc=SimpleDocTemplate(file)


    story.append(Paragraph("🚗 DRIVER SAFETY REPORT",styles["Heading1"]))

    story.append(Spacer(1,20))


    story.append(Paragraph(f"Timestamp: {datetime.now()}",styles["Normal"]))

    story.append(Paragraph(f"Session Duration: {duration} sec",styles["Normal"]))

    story.append(Paragraph(f"Fatigue Score: {fatigue}",styles["Normal"]))

    story.append(Paragraph(f"Yawns Detected: {yawns}",styles["Normal"]))

    story.append(Paragraph(f"Alerts Triggered: {alerts}",styles["Normal"]))

    story.append(Paragraph(f"Risk Level: {status}",styles["Normal"]))

    story.append(Paragraph(f"Recommendation: {recommendation}",styles["Normal"]))


    if st.session_state.lat:

        story.append(Paragraph(

            f"Location: {st.session_state.city}",

            styles["Normal"]

        ))


    story.append(Spacer(1,20))


    if os.path.exists(graph_img):

        story.append(Image(graph_img,width=400,height=250))


    doc.build(story)

    return file


# ================= SIDEBAR =================

st.sidebar.title("Control Panel")

gps_btn=st.sidebar.button("Send GPS Alert")

start=st.sidebar.button("Start Monitoring")

report_btn=st.sidebar.button("Generate Report")


# ================= DASHBOARD =================

col1,col2,col3,col4=st.columns(4)

score_box=col1.empty()

alert_box=col2.empty()

yawn_box=col3.empty()

timer_box=col4.empty()

frame_area=st.empty()

status_area=st.empty()


# ================= GPS BUTTON =================

if gps_btn:

    gps_alert()


# ================= MONITOR =================

if start:

    st.session_state.start_time=time.time()

    cap=cv2.VideoCapture(0,cv2.CAP_DSHOW)

    if not cap.isOpened():

        cap=cv2.VideoCapture("driver.mp4")


    counter=0


    while cap.isOpened():

        ret,frame=cap.read()

        if not ret:

            break


        gray=cv2.cvtColor(frame,cv2.COLOR_BGR2GRAY)

        faces=detector(gray)


        for face in faces:

            landmarks=predictor(gray,face)


            left_eye=[(landmarks.part(i).x,landmarks.part(i).y) for i in range(36,42)]

            right_eye=[(landmarks.part(i).x,landmarks.part(i).y) for i in range(42,48)]

            mouth=[(landmarks.part(i).x,landmarks.part(i).y) for i in range(48,68)]


            ear=(EAR(left_eye)+EAR(right_eye))/2

            mar=MAR(mouth)


            st.session_state.ear_history.append(ear)


            if ear<EAR_THRESHOLD:

                counter+=1

                st.session_state.fatigue_score+=1


            if mar>MAR_THRESHOLD:

                st.session_state.yawn_counter+=1


            if counter>15:

                st.session_state.alert_counter+=1

                status_area.error("⚠ DRIVER DROWSY")

                threading.Thread(target=alarm).start()

                gps_alert()

                whatsapp_alert()

            else:

                status_area.success("✅ DRIVER ALERT")


        fatigue_percent=min(st.session_state.fatigue_score*2,100)


        score_box.metric("Fatigue %",fatigue_percent)

        alert_box.metric("Alerts",st.session_state.alert_counter)

        yawn_box.metric("Yawns",st.session_state.yawn_counter)

        timer_box.metric("Session Time",int(time.time()-st.session_state.start_time))


        st.plotly_chart(fatigue_meter(fatigue_percent),use_container_width=True)


        frame_area.image(cv2.cvtColor(frame,cv2.COLOR_BGR2RGB))


        time.sleep(0.03)


    cap.release()


# ================= REPORT DOWNLOAD =================

if report_btn:

    pdf=generate_report()

    with open(pdf,"rb") as f:

        st.download_button("📄 Download Driver Report",f,file_name="Driver_Report.pdf")

    st.success("Report Generated Successfully")