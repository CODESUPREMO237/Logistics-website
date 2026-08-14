'use client'

import React, { useEffect, useRef } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import 'leaflet-pulse-icon'

// Fix default Leaflet icons
delete L.Icon.Default.prototype._getIconUrl
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
})

// Default fallback coordinates
const DEFAULT_CENTER_LAT = 39.8283
const DEFAULT_CENTER_LNG = -98.5795

// Ship icon
const shipIcon = L.icon({
  iconUrl: 'https://cdn-icons-png.flaticon.com/512/3208/3208358.png',
  iconSize: [38, 38],
  iconAnchor: [19, 38],
})

const waypointIcon = L.icon({
  iconUrl: 'https://cdn-icons-png.flaticon.com/512/252/252025.png', // small dot icon
  iconSize: [12, 12],
  iconAnchor: [6, 6],
})

const safeParseFloat = (val) => {
  const parsed = parseFloat(val)
  return isNaN(parsed) ? null : parsed
}

/**
 * Adjust `lng` so the path from `refLng` to `lng` takes the shortest route,
 * crossing the antimeridian (±180°) when that's shorter.
 * e.g. Australia (135°E) → US (-95°W): returns -95+360=265 so the line goes
 * eastward across the Pacific instead of westward through Africa.
 */
function adjustLng(refLng, lng) {
  let diff = lng - refLng
  if (diff > 180) return lng - 360
  if (diff < -180) return lng + 360
  return lng
}

/**
 * Given an array of [lat, lng] points, adjust all longitudes so each segment
 * takes the shortest path (handles antimeridian crossings).
 */
function adjustPath(points) {
  if (!points || points.length === 0) return points
  const result = [[points[0][0], points[0][1]]]
  for (let i = 1; i < points.length; i++) {
    const prevLng = result[i - 1][1]
    result.push([points[i][0], adjustLng(prevLng, points[i][1])])
  }
  return result
}

export default function MapLeaflet({ lat, lng, originLat, originLng, destLat, destLng, status }) {
  const mapRef = useRef(null)
  const mapInstanceRef = useRef(null)
  const markerRef = useRef(null)
  const routeRef = useRef(null)
  const dashedRef = useRef(null)
  const animationRef = useRef(null)
  const waypointsRef = useRef([]) // store [lat, lng] history
  const waypointMarkersRef = useRef([]) // markers for history points
  const prevStatusRef = useRef(status)

  const currentLat = safeParseFloat(lat)
  const currentLng = safeParseFloat(lng)
  const startLat = safeParseFloat(originLat)
  const startLng = safeParseFloat(originLng)
  const destinationLat = safeParseFloat(destLat)
  const destinationLng = safeParseFloat(destLng)

  // Utility easing for smooth deceleration (easeOutQuad)
  const easeOut = (t) => 1 - (1 - t) * (1 - t)

  // Initialize map once
  useEffect(() => {
    if (mapRef.current && !mapInstanceRef.current) {
      const centerLat = currentLat || startLat || destinationLat || DEFAULT_CENTER_LAT
      const centerLng = currentLng || startLng || destinationLng || DEFAULT_CENTER_LNG

      const map = L.map(mapRef.current, { zoomControl: true, worldCopyJump: true }).setView([centerLat, centerLng], 4)
      mapInstanceRef.current = map

      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap contributors',
      }).addTo(map)

      // Marker for current location
      const marker = L.marker([currentLat || centerLat, currentLng || centerLng], { icon: shipIcon })
        .addTo(map)
        .bindPopup('Current Location')
      markerRef.current = marker

      // Initial route (origin -> current) with antimeridian-aware path
      const initPoints = adjustPath([
        [startLat, startLng],
        [currentLat || startLat, currentLng || startLng],
      ])
      const initialRoute = L.polyline(initPoints, { color: '#0f76e6', weight: 4, opacity: 0.9 }).addTo(map)
      routeRef.current = initialRoute

      // Destination marker (pulse)
      if (destinationLat && destinationLng) {
        L.marker([destinationLat, destinationLng], {
          icon: L.icon.pulse({
            iconSize: [18, 18],
            color: 'red',
            fillColor: 'red',
          }),
        })
          .addTo(map)
          .bindPopup('Destination')
      }

      // If bounds available, fit map (use adjusted path for correct bounding)
      if (startLat && startLng && destinationLat && destinationLng) {
        const adjDestLng = adjustLng(startLng, destinationLng)
        const allLngs = [startLng, adjDestLng]
        if (currentLng !== null) allLngs.push(adjustLng(startLng, currentLng))
        const allLats = [startLat]
        if (destinationLat) allLats.push(destinationLat)
        if (currentLat !== null) allLats.push(currentLat)
        const bounds = L.latLngBounds(
          [Math.min(...allLats), Math.min(...allLngs)],
          [Math.max(...allLats), Math.max(...allLngs)]
        )
        map.fitBounds(bounds, { padding: [50, 50] })
      } else if (startLat && startLng) {
        map.setView([startLat, startLng], 8)
      } else if (destinationLat && destinationLng) {
        map.setView([destinationLat, destinationLng], 8)
      }
    }

    // cleanup on unmount
    return () => {
      if (animationRef.current) cancelAnimationFrame(animationRef.current)
      if (mapInstanceRef.current) {
        try {
          mapInstanceRef.current.remove()
        } catch (e) {
          // ignore
        }
      }
      mapInstanceRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []) // run once

  // Helper to add waypoint marker
  const addWaypointMarker = (pos) => {
    const map = mapInstanceRef.current
    if (!map) return
    const m = L.circleMarker(pos, { radius: 4, fill: true, fillOpacity: 1, color: '#0f76e6' }).addTo(map)
    waypointMarkersRef.current.push(m)
  }

  // Remove dashed line if present
  const clearDashed = () => {
    if (dashedRef.current) {
      try {
        mapInstanceRef.current.removeLayer(dashedRef.current)
      } catch (e) {}
      dashedRef.current = null
    }
  }

  /** Build the full adjusted path from origin through waypoints to a final point */
  const buildAdjustedRoute = (finalLat, finalLng) => {
    const raw = [[startLat, startLng], ...waypointsRef.current, [finalLat, finalLng]]
    return adjustPath(raw)
  }

  // Animate marker using easing; updates route polyline as it moves
  const animateMarker = (marker, fromLatLng, toLatLng, duration = 2000) => {
    const startTime = performance.now()
    if (animationRef.current) cancelAnimationFrame(animationRef.current)

    // Pre-calculate the adjusted target longitude for smooth interpolation
    const adjToLng = adjustLng(fromLatLng.lng, toLatLng.lng)

    const animate = (time) => {
      const raw = Math.min((time - startTime) / duration, 1)
      const progress = easeOut(raw) // ease out for deceleration
      const lat = fromLatLng.lat + (toLatLng.lat - fromLatLng.lat) * progress
      const lng = fromLatLng.lng + (adjToLng - fromLatLng.lng) * progress
      marker.setLatLng([lat, lng])

      // route = origin -> waypoints -> current animated point
      if (routeRef.current) routeRef.current.setLatLngs(buildAdjustedRoute(lat, lng))

      if (raw < 1) {
        animationRef.current = requestAnimationFrame(animate)
      } else {
        animationRef.current = null
      }
    }

    animationRef.current = requestAnimationFrame(animate)
  }

  /** Create a dashed polyline from current position to destination, antimeridian-aware */
  const createDashedLine = (fromLat, fromLng, toLat, toLng, map) => {
    const adjToLng = adjustLng(fromLng, toLng)
    return L.polyline([[fromLat, fromLng], [toLat, adjToLng]], {
      color: 'red',
      weight: 2,
      dashArray: '6 8',
      opacity: 0.8,
    }).addTo(map)
  }

  // Update marker when coords or status changes
  useEffect(() => {
    const marker = markerRef.current
    const map = mapInstanceRef.current
    if (!marker || currentLat === null || currentLng === null || !map) return

    const isMoving = status === 'In Transit'
    const prevStatus = prevStatusRef.current

    // When status changed from moving -> stopped, do a short deceleration animation to final pos
    const justStopped = prevStatus === 'In Transit' && !isMoving

    if (justStopped) {
      // finish with a short decel then freeze
      const from = marker.getLatLng()
      const to = L.latLng(currentLat, currentLng)
      // push one last waypoint target
      waypointsRef.current.push([to.lat, to.lng])
      addWaypointMarker([to.lat, to.lng])
      animateMarker(marker, from, to, 1200)

      // after decel, freeze marker and show dashed route to destination
      setTimeout(() => {
        if (animationRef.current) cancelAnimationFrame(animationRef.current)
        marker.setLatLng([currentLat, currentLng])
        if (routeRef.current) {
          routeRef.current.setLatLngs(adjustPath([[startLat, startLng], ...waypointsRef.current]))
        }
        clearDashed()
        if (destinationLat && destinationLng) {
          dashedRef.current = createDashedLine(currentLat, currentLng, destinationLat, destinationLng, map)
        }
        // Auto zoom if delivered
        if (status === 'Delivered') {
          map.flyTo([currentLat, currentLng], 10, { duration: 1.2 })
        }
      }, 1250)

      prevStatusRef.current = status
      return
    }

    // Not moving (initially stopped or on hold/cancelled/delivered)
    if (!isMoving) {
      if (animationRef.current) cancelAnimationFrame(animationRef.current)

      // Only add waypoint if new position differs significantly from last
      const last = waypointsRef.current[waypointsRef.current.length - 1]
      const lastLat = last?.[0]
      const lastLng = last?.[1]
      if (!last || Math.abs(lastLat - currentLat) > 1e-6 || Math.abs(lastLng - currentLng) > 1e-6) {
        waypointsRef.current.push([currentLat, currentLng])
        addWaypointMarker([currentLat, currentLng])
      }

      marker.setLatLng([currentLat, currentLng])
      if (routeRef.current) {
        routeRef.current.setLatLngs(adjustPath([[startLat, startLng], ...waypointsRef.current]))
      }

      clearDashed()
      if (destinationLat && destinationLng) {
        dashedRef.current = createDashedLine(currentLat, currentLng, destinationLat, destinationLng, map)
      }

      // Auto-zoom on delivered
      if (status === 'Delivered') {
        setTimeout(() => {
          if (mapInstanceRef.current) {
            mapInstanceRef.current.flyTo([currentLat, currentLng], 10, { duration: 1.2 })
          }
        }, 600)
      }

      prevStatusRef.current = status
      return
    }

    // If we are here, the ship is moving (In Transit)
    // remove any dashed preview to destination (we have live route)
    clearDashed()

    // Add new waypoint
    const to = L.latLng(currentLat, currentLng)
    const from = marker.getLatLng()
    // only push waypoint if significantly different to avoid duplicates
    const last = waypointsRef.current[waypointsRef.current.length - 1]
    if (!last || Math.abs(last[0] - to.lat) > 1e-6 || Math.abs(last[1] - to.lng) > 1e-6) {
      waypointsRef.current.push([to.lat, to.lng])
      addWaypointMarker([to.lat, to.lng])
    }

    // animate smoothly
    animateMarker(marker, from, to, 8000)

    // update polyline full path
    if (routeRef.current) {
      routeRef.current.setLatLngs(adjustPath([[startLat, startLng], ...waypointsRef.current]))
    }

    prevStatusRef.current = status
  }, [currentLat, currentLng, status, startLat, startLng, destinationLat, destinationLng])

  return <div ref={mapRef} style={{ height: '500px', width: '100%', borderRadius: '0 0 12px 12px' }} />
}
