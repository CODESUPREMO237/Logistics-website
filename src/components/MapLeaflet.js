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

const safeParseFloat = (val) => {
  const parsed = parseFloat(val)
  return isNaN(parsed) ? null : parsed
}

/**
 * Adjust `lng` so the path from `refLng` to `lng` takes the shortest route,
 * crossing the antimeridian (±180°) when that is shorter.
 */
function adjustLng(refLng, lng) {
  const diff = lng - refLng
  if (diff > 180) return lng - 360
  if (diff < -180) return lng + 360
  return lng
}

/**
 * Returns true when the shortest path between two longitudes crosses ±180°.
 */
function crossesAntimeridian(lng1, lng2) {
  return Math.abs(lng2 - lng1) > 180
}

/**
 * Split a path of [lat, lng] points into multiple sub-paths wherever the
 * shortest route crosses the antimeridian (±180°).
 * Each sub-path can be drawn as a normal Leaflet polyline.
 *
 * e.g. Australia (151°E) → US (-95°W) becomes:
 *   Segment 1: [ausLat, 151] → [crossLat, 180]
 *   Segment 2: [crossLat, -180] → [usLat, -95]
 */
function splitPathAtAntimeridian(points) {
  if (!points || points.length < 2) return [points]

  const paths = []
  let currentPath = [points[0]]

  for (let i = 1; i < points.length; i++) {
    const [lat1, lng1] = currentPath[currentPath.length - 1]
    const [lat2, lng2] = points[i]

    if (crossesAntimeridian(lng1, lng2)) {
      // Unwrap lng2 to determine the real crossing direction
      const adjLng2 = (lng2 - lng1 > 180) ? lng2 - 360 : lng2 + 360
      const crossLng = adjLng2 > lng1 ? 180 : -180
      const t = (crossLng - lng1) / (adjLng2 - lng1)
      const crossLat = lat1 + t * (lat2 - lat1)

      // End this segment at the antimeridian edge
      currentPath.push([crossLat, crossLng])
      paths.push(currentPath)

      // Start a new segment from the other edge
      currentPath = [[crossLat, -crossLng], [lat2, lng2]]
    } else {
      currentPath.push([lat2, lng2])
    }
  }

  paths.push(currentPath)
  return paths
}

/**
 * Replace all polylines inside a LayerGroup with new ones derived from
 * `points`, splitting at the antimeridian where necessary.
 */
function setLayerGroupPolylines(layerGroup, points, options) {
  layerGroup.clearLayers()
  const segments = splitPathAtAntimeridian(points)
  segments.forEach((seg) => {
    if (seg && seg.length >= 2) {
      L.polyline(seg, options).addTo(layerGroup)
    }
  })
}

export default function MapLeaflet({ lat, lng, originLat, originLng, destLat, destLng, status }) {
  const mapRef = useRef(null)
  const mapInstanceRef = useRef(null)
  const markerRef = useRef(null)
  const routeRef = useRef(null)   // L.LayerGroup for the solid blue route
  const dashedRef = useRef(null)  // L.LayerGroup for the dashed red remaining route
  const animationRef = useRef(null)
  const waypointsRef = useRef([]) // [lat, lng] history
  const waypointMarkersRef = useRef([])
  const prevStatusRef = useRef(status)

  const currentLat = safeParseFloat(lat)
  const currentLng = safeParseFloat(lng)
  const startLat = safeParseFloat(originLat)
  const startLng = safeParseFloat(originLng)
  const destinationLat = safeParseFloat(destLat)
  const destinationLng = safeParseFloat(destLng)

  const solidStyle = { color: '#0f76e6', weight: 4, opacity: 0.9 }
  const dashedStyle = { color: 'red', weight: 2, dashArray: '6 8', opacity: 0.8 }

  // Utility easing for smooth deceleration (easeOutQuad)
  const easeOut = (t) => 1 - (1 - t) * (1 - t)

  // --------------- Initialise map once ---------------
  useEffect(() => {
    if (mapRef.current && !mapInstanceRef.current) {
      const centerLat = currentLat || startLat || destinationLat || DEFAULT_CENTER_LAT
      const centerLng = currentLng || startLng || destinationLng || DEFAULT_CENTER_LNG

      const map = L.map(mapRef.current, { zoomControl: true }).setView([centerLat, centerLng], 4)
      mapInstanceRef.current = map

      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap contributors',
      }).addTo(map)

      // Ship marker
      const marker = L.marker([currentLat || centerLat, currentLng || centerLng], { icon: shipIcon })
        .addTo(map)
        .bindPopup('Current Location')
      markerRef.current = marker

      // Solid route layer group (origin → current)
      const routeGroup = L.layerGroup().addTo(map)
      routeRef.current = routeGroup
      setLayerGroupPolylines(routeGroup,
        [[startLat, startLng], [currentLat || startLat, currentLng || startLng]],
        solidStyle,
      )

      // Dashed route layer group (current → destination)
      const dashedGroup = L.layerGroup().addTo(map)
      dashedRef.current = dashedGroup

      // Destination marker (pulse)
      if (destinationLat && destinationLng) {
        L.marker([destinationLat, destinationLng], {
          icon: L.icon.pulse({ iconSize: [18, 18], color: 'red', fillColor: 'red' }),
        })
          .addTo(map)
          .bindPopup('Destination')
      }

      // Fit the view — handle antimeridian-crossing routes
      if (startLat != null && startLng != null && destinationLat != null && destinationLng != null) {
        if (crossesAntimeridian(startLng, destinationLng)) {
          // For routes crossing the antimeridian, centre on the Pacific
          const adjDestLng = adjustLng(startLng, destinationLng)
          const midLat = (startLat + destinationLat) / 2
          let midLng = (startLng + adjDestLng) / 2
          if (midLng > 180) midLng -= 360
          if (midLng < -180) midLng += 360
          map.setView([midLat, midLng], 2)
        } else {
          map.fitBounds(
            [[startLat, startLng], [destinationLat, destinationLng]],
            { padding: [50, 50] },
          )
        }
      } else if (startLat && startLng) {
        map.setView([startLat, startLng], 8)
      } else if (destinationLat && destinationLng) {
        map.setView([destinationLat, destinationLng], 8)
      }
    }

    // Cleanup on unmount
    return () => {
      if (animationRef.current) cancelAnimationFrame(animationRef.current)
      if (mapInstanceRef.current) {
        try { mapInstanceRef.current.remove() } catch (e) { /* ignore */ }
      }
      mapInstanceRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []) // run once

  // --------------- Helpers ---------------
  const addWaypointMarker = (pos) => {
    const map = mapInstanceRef.current
    if (!map) return
    const m = L.circleMarker(pos, { radius: 4, fill: true, fillOpacity: 1, color: '#0f76e6' }).addTo(map)
    waypointMarkersRef.current.push(m)
  }

  const clearDashed = () => {
    if (dashedRef.current) dashedRef.current.clearLayers()
  }

  /** Rebuild the solid route polyline(s) from origin through all waypoints to `finalPos` */
  const updateRoute = (finalLat, finalLng) => {
    if (!routeRef.current) return
    const points = [[startLat, startLng], ...waypointsRef.current, [finalLat, finalLng]]
    setLayerGroupPolylines(routeRef.current, points, solidStyle)
  }

  /** Draw / redraw the dashed remaining route from one point to another */
  const updateDashed = (fromLat, fromLng, toLat, toLng) => {
    if (!dashedRef.current) return
    setLayerGroupPolylines(dashedRef.current, [[fromLat, fromLng], [toLat, toLng]], dashedStyle)
  }

  // --------------- Animation ---------------
  const animateMarker = (marker, fromLatLng, toLatLng, duration = 2000) => {
    const startTime = performance.now()
    if (animationRef.current) cancelAnimationFrame(animationRef.current)

    // Use adjusted longitude for smooth interpolation across the antimeridian
    const adjToLng = adjustLng(fromLatLng.lng, toLatLng.lng)

    const animate = (time) => {
      const raw = Math.min((time - startTime) / duration, 1)
      const progress = easeOut(raw)
      const animLat = fromLatLng.lat + (toLatLng.lat - fromLatLng.lat) * progress
      let animLng = fromLatLng.lng + (adjToLng - fromLatLng.lng) * progress
      // Normalise back to [-180, 180] for marker placement and path building
      if (animLng > 180) animLng -= 360
      if (animLng < -180) animLng += 360

      marker.setLatLng([animLat, animLng])
      updateRoute(animLat, animLng)

      if (raw < 1) {
        animationRef.current = requestAnimationFrame(animate)
      } else {
        animationRef.current = null
      }
    }

    animationRef.current = requestAnimationFrame(animate)
  }

  // --------------- React to coordinate / status changes ---------------
  useEffect(() => {
    const marker = markerRef.current
    const map = mapInstanceRef.current
    if (!marker || currentLat === null || currentLng === null || !map) return

    const isMoving = status === 'In Transit'
    const prevStatus = prevStatusRef.current

    // --- Ship just stopped (In Transit → anything else) ---
    const justStopped = prevStatus === 'In Transit' && !isMoving
    if (justStopped) {
      const from = marker.getLatLng()
      const to = L.latLng(currentLat, currentLng)
      waypointsRef.current.push([to.lat, to.lng])
      addWaypointMarker([to.lat, to.lng])
      animateMarker(marker, from, to, 1200)

      setTimeout(() => {
        if (animationRef.current) cancelAnimationFrame(animationRef.current)
        marker.setLatLng([currentLat, currentLng])
        updateRoute(currentLat, currentLng)
        clearDashed()
        if (destinationLat && destinationLng) {
          updateDashed(currentLat, currentLng, destinationLat, destinationLng)
        }
        if (status === 'Delivered') {
          map.flyTo([currentLat, currentLng], 10, { duration: 1.2 })
        }
      }, 1250)

      prevStatusRef.current = status
      return
    }

    // --- Not moving (idle / on hold / cancelled / delivered) ---
    if (!isMoving) {
      if (animationRef.current) cancelAnimationFrame(animationRef.current)

      const last = waypointsRef.current[waypointsRef.current.length - 1]
      if (!last || Math.abs(last[0] - currentLat) > 1e-6 || Math.abs(last[1] - currentLng) > 1e-6) {
        waypointsRef.current.push([currentLat, currentLng])
        addWaypointMarker([currentLat, currentLng])
      }

      marker.setLatLng([currentLat, currentLng])
      updateRoute(currentLat, currentLng)

      clearDashed()
      if (destinationLat && destinationLng) {
        updateDashed(currentLat, currentLng, destinationLat, destinationLng)
      }

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

    // --- In Transit (moving) ---
    clearDashed()

    const to = L.latLng(currentLat, currentLng)
    const from = marker.getLatLng()
    const last = waypointsRef.current[waypointsRef.current.length - 1]
    if (!last || Math.abs(last[0] - to.lat) > 1e-6 || Math.abs(last[1] - to.lng) > 1e-6) {
      waypointsRef.current.push([to.lat, to.lng])
      addWaypointMarker([to.lat, to.lng])
    }

    animateMarker(marker, from, to, 8000)
    updateRoute(currentLat, currentLng)

    prevStatusRef.current = status
  }, [currentLat, currentLng, status, startLat, startLng, destinationLat, destinationLng])

  return <div ref={mapRef} style={{ height: '500px', width: '100%', borderRadius: '0 0 12px 12px' }} />
}
