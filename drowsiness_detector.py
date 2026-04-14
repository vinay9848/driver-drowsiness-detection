import cv2
import dlib
from scipy.spatial import distance

# Function to calculate Eye Aspect Ratio
def eye_aspect_ratio(eye):
    A = distance.euclidean(eye[1], eye[5])
    B = distance.euclidean(eye[2], eye[4])
    C = distance.euclidean(eye[0], eye[3])

    ear = (A + B) / (2.0 * C)
    return ear


# Threshold values
EAR_THRESHOLD = 0.25
CONSEC_FRAMES = 20
counter = 0

# Load face detector and landmark predictor
detector = dlib.get_frontal_face_detector()
predictor = dlib.shape_predictor("shape_predictor_68_face_landmarks.dat")

# Eye landmark indexes
left_eye = list(range(36, 42))
right_eye = list(range(42, 48))

# Start webcam
cap = cv2.VideoCapture(0, cv2.CAP_DSHOW)

while True:

    ret, frame = cap.read()
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)

    faces = detector(gray)

    for face in faces:

        landmarks = predictor(gray, face)

        left_eye_points = []
        right_eye_points = []

        for n in left_eye:
            x = landmarks.part(n).x
            y = landmarks.part(n).y
            left_eye_points.append((x, y))

        for n in right_eye:
            x = landmarks.part(n).x
            y = landmarks.part(n).y
            right_eye_points.append((x, y))

        leftEAR = eye_aspect_ratio(left_eye_points)
        rightEAR = eye_aspect_ratio(right_eye_points)

        ear = (leftEAR + rightEAR) / 2.0

        # Draw EAR value
        cv2.putText(frame, f"EAR: {ear:.2f}", (300,50),
                    cv2.FONT_HERSHEY_SIMPLEX, 1, (0,255,0), 2)

        if ear < EAR_THRESHOLD:
            counter += 1

            if counter >= CONSEC_FRAMES:
                cv2.putText(frame, "DROWSINESS ALERT!", (50,100),
                            cv2.FONT_HERSHEY_SIMPLEX, 1.5, (0,0,255), 3)

        else:
            counter = 0

    cv2.imshow("Driver Drowsiness Detection", frame)

    key = cv2.waitKey(1)

    if key == 27:   # Press ESC to exit
        break

cap.release()
cv2.destroyAllWindows()